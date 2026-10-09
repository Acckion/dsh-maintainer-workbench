/** The current settings shell hard-codes unknown section icons to a gear.
 * Decorate only this plugin's nav entry; leave shell markup/state untouched.
 * The marker is presentation-only and removed when the plugin is disposed. */
export function installSettingsIcon(root: Document = document): () => void {
  const decorate = () => {
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-shortcut-modal="settings"] nav button')) {
      if (button.textContent?.trim() === "维护工作台" && button.querySelector('svg'))
        button.dataset.mwSettingsEntry = "";
    }
  };
  const observer = new MutationObserver(decorate);
  observer.observe(root.body, {subtree:true,childList:true}); decorate();
  return () => { observer.disconnect();root.querySelectorAll('[data-mw-settings-entry]').forEach(e=>e.removeAttribute('data-mw-settings-entry')); };
}
