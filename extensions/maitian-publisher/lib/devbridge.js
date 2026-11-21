// Modified for dsh-media-desk (Apache-2.0):
// 安全加固：关闭本机 127.0.0.1:8765 开发桥接长轮询，防止其他本机进程通过该端口调用 chrome.debugger。

export async function startDevBridge() {
  return;
}
