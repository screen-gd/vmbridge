/** Copies text to the clipboard and reports whether it worked. */
export async function copyText(text: string, near: HTMLElement): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied or the page lost focus: the selection fallback below may still work.
    }
  }
  return copyBySelection(text, near);
}

// navigator.clipboard only exists in secure contexts (HTTPS or localhost). The dashboard is
// often opened over plain HTTP through a LAN or Tailscale address, so select the text in a
// hidden textarea and use execCommand("copy"), which still works there and in Safari.
// The textarea goes next to `near` so a dialog's focus trap can't pull focus away from it.
function copyBySelection(text: string, near: HTMLElement) {
  const focused = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)) : [];

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  near.after(textarea);
  textarea.select();
  // iOS ignores select() on its own.
  textarea.setSelectionRange(0, text.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  textarea.remove();
  if (selection) {
    selection.removeAllRanges();
    for (const range of ranges) selection.addRange(range);
  }
  if (focused instanceof HTMLElement) focused.focus();
  return copied;
}
