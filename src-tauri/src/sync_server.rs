//! 局域网 WebSocket 广播服务 —— 让手机端通过 `ws://<桌面IP>:<port>` 接入桌面端标注会话。
//!
//! 设计原则（骨架阶段，简单稳妥优先）：
//! - 服务端**不解析消息语义**，只做"任意客户端发来的消息原样转发给其他连接"。
//! - 因此协议升级（裸 WS → Yjs CRDT）只影响客户端，服务端实现保持不变。
//! - 复用 Tauri 自带的 async runtime 跑 accept_loop，不另起 runtime。
//!
//! 端口策略：默认 0（系统分配空闲端口），通过命令返回实际端口；
//! 手机端通过二维码 / mDNS 拿到（骨架阶段由前端展示 URL，教师扫码或手输）。

use std::net::SocketAddr;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message;

/// 运行中的同步服务状态（存到 Tauri managed state，防止 shutdown_tx 被 drop 导致 accept_loop 退出）
pub struct SyncServerState {
    pub port: u16,
    pub lan_ip: String,
    pub shutdown_tx: broadcast::Sender<()>,
}

pub type SyncServerManaged = Mutex<Option<SyncServerState>>;

async fn accept_loop(listener: TcpListener, mut shutdown: broadcast::Receiver<()>) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::accept_async;

    // 广播 channel：任意 peer 发的消息 → 所有其他 peer 收到
    // 容量 1024：pointer 消息洪峰时避免 receiver lag 导致命令消息被丢弃
    let (msg_tx, _) = broadcast::channel::<PeerMessage>(1024);
    let peer_count = std::sync::Arc::new(std::sync::Mutex::new(0u32));

    tracing::info!("[sync_server] accept_loop running, listening on {}", listener.local_addr().unwrap());

    loop {
        tokio::select! {
            _ = shutdown.recv() => {
                tracing::info!("[sync_server] shutdown signal received, exiting accept loop");
                break;
            }
            accept_result = listener.accept() => {
                let (stream, peer_addr) = match accept_result {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!("[sync_server] accept failed: {e}");
                        continue;
                    }
                };
                tracing::info!("[sync_server] new connection from {peer_addr}");
                let peer_id = PeerId(peer_addr.to_string());
                let msg_tx_clone = msg_tx.clone();
                let peer_count_clone = peer_count.clone();
                let mut shutdown_clone = shutdown.resubscribe();
                tokio::spawn(async move {
                    let ws_stream = match accept_async(stream).await {
                        Ok(s) => s,
                        Err(e) => {
                            tracing::warn!("[sync_server] ws handshake failed ({peer_addr}): {e}");
                            return;
                        }
                    };
                    let (mut write, mut read) = ws_stream.split();

                    // 订阅广播 → 投递给本 peer（同时过滤发送者，防回环）
                    let mut rx_broadcast = msg_tx_clone.subscribe();
                    let peer_id_for_forward = peer_id.clone();
                    let forward_task = tokio::spawn(async move {
                        loop {
                            match rx_broadcast.recv().await {
                                Ok(pm) => {
                                    if pm.from == peer_id_for_forward { continue; }
                                    if write.send(pm.msg).await.is_err() { break; }
                                }
                                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                                Err(broadcast::error::RecvError::Closed) => break,
                            }
                        }
                    });

                    {
                        let mut count = peer_count_clone.lock().expect("peer_count poisoned");
                        *count += 1;
                    }
                    loop {
                        tokio::select! {
                            _ = shutdown_clone.recv() => break,
                            maybe_msg = read.next() => {
                                match maybe_msg {
                                    Some(Ok(msg)) => {
                                        if msg.is_text() || msg.is_binary() {
                                            let _ = msg_tx_clone.send(PeerMessage {
                                                from: peer_id.clone(),
                                                msg,
                                            });
                                        } else if msg.is_close() {
                                            break;
                                        }
                                    }
                                    Some(Err(e)) => {
                                        tracing::debug!("[sync_server] read error ({peer_addr}): {e}");
                                        break;
                                    }
                                    None => break,
                                }
                            }
                        }
                    }
                    forward_task.abort();
                    {
                        let mut count = peer_count_clone.lock().expect("peer_count poisoned");
                        *count = count.saturating_sub(1);
                    }
                    tracing::info!("[sync_server] connection closed ({peer_addr})");
                });
            }
        }
    }
}

#[derive(Hash, Eq, PartialEq, Clone, Debug)]
struct PeerId(String);

#[derive(Clone)]
struct PeerMessage {
    from: PeerId,
    msg: Message,
}

/// 获取本机用于访问外网的网卡 IPv4（手机端通过此 IP 连桌面端）。
fn get_lan_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket
        .local_addr()
        .ok()
        .map(|a| a.ip().to_string())
}

/// 启动同步服务的 Tauri 命令（异步，复用 Tauri runtime）。
/// 重复调用时若已有运行中的服务，直接返回已有端口。
#[tauri::command]
pub async fn start_sync_server(app: AppHandle) -> Result<serde_json::Value, String> {
    // 已有服务则直接返回
    if let Some(managed) = app.try_state::<SyncServerManaged>() {
        if let Some(state) = managed.lock().unwrap().as_ref() {
            let port = state.port;
            let lan_ip = state.lan_ip.clone();
            tracing::info!("[sync_server] already running on port {port}, returning existing");
            return Ok(serde_json::json!({
                "port": port,
                "ws_url": format!("ws://{lan_ip}:{port}"),
                "lan_ip": lan_ip,
            }));
        }
    }

    let listener = TcpListener::bind(("0.0.0.0", 0))
        .await
        .map_err(|e| format!("绑定端口失败: {e}"))?;
    let addr: SocketAddr = listener.local_addr().map_err(|e| format!("获取地址失败: {e}"))?;
    let port = addr.port();
    let lan_ip = get_lan_ip().unwrap_or_else(|| "127.0.0.1".to_string());
    let ws_url = format!("ws://{lan_ip}:{port}");

    let (shutdown_tx, shutdown_rx) = broadcast::channel::<()>(1);

    // 复用 Tauri 的 async runtime 跑 accept_loop
    tauri::async_runtime::spawn(accept_loop(listener, shutdown_rx));

    // 存储 shutdown_tx，防止 channel 关闭导致 accept_loop 退出
    app.manage(Mutex::new(Some(SyncServerState {
        port,
        lan_ip: lan_ip.clone(),
        shutdown_tx,
    })));

    let payload = serde_json::json!({
        "port": port,
        "ws_url": ws_url,
        "lan_ip": lan_ip,
        "addr": addr.to_string(),
    });
    let _ = app.emit("sync-server-started", payload.clone());
    tracing::info!("[sync_server] started on port {port} (lan_ip={lan_ip}, bind={addr})");

    Ok(payload)
}

/// 停止同步服务的 Tauri 命令。
#[tauri::command]
pub fn stop_sync_server(app: AppHandle) -> Result<(), String> {
    if let Some(managed) = app.try_state::<SyncServerManaged>() {
        if let Some(state) = managed.lock().unwrap().take() {
            let _ = state.shutdown_tx.send(());
            tracing::info!("[sync_server] stop requested, shutting down");
        }
    }
    Ok(())
}
