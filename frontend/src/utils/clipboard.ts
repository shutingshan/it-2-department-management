/**
 * 复制文本到剪贴板。
 *
 * 不能直接用 navigator.clipboard：它只在安全上下文（HTTPS 或 localhost）下才存在，
 * 而本系统是部署在 http 的服务器地址上访问的，那里 navigator.clipboard 是 undefined，
 * 直接调用会抛异常——既没复制成功，提示也弹不出来。
 * 因此优先走 Clipboard API，不可用时退回 execCommand("copy") 这套老办法。
 *
 * @returns 是否复制成功，调用方据此决定提示成功还是失败
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 用户拒绝授权等情况：继续尝试下面的兜底方案
    }
  }

  // 弹窗（antd Modal）有焦点锁：临时元素若挂在 body 上会选不中，execCommand 会复制到空内容。
  // 所以有弹窗打开时挂到弹窗里面
  const host = document.activeElement?.closest<HTMLElement>('[role="dialog"]') ?? document.body;

  // execCommand 只负责触发 copy 事件，真正写入的内容由这个监听器直接指定，
  // 不依赖选区是否被正确保留
  let wrote = false;
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
    wrote = true;
  };

  const textarea = document.createElement("textarea");
  try {
    textarea.value = text;
    // 固定定位到视口外，避免复制瞬间页面闪动或被滚动
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    textarea.setAttribute("readonly", "");
    host.appendChild(textarea);
    textarea.focus();
    textarea.select();
    // iOS Safari 上 select() 不够，需要显式指定选区
    textarea.setSelectionRange(0, textarea.value.length);

    document.addEventListener("copy", onCopy);
    const executed = document.execCommand("copy");
    return executed && wrote;
  } catch {
    return false;
  } finally {
    document.removeEventListener("copy", onCopy);
    textarea.remove();
  }
}
