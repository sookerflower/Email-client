import { enhancedKeyboardShortcuts } from '@/config/shortcuts';
import { useShortcuts } from './use-hotkey-utils';
import { useQueryState } from 'nuqs';

export function ComposeHotkeys() {
  const scope = 'compose';
  const [isComposeOpen, setIsComposeOpen] = useQueryState('isComposeOpen');

  const handlers = {
    closeCompose: () => {
      if (isComposeOpen === 'true') {
        // Closed = param ABSENT (null). Every writer uses 'true'/null and
        // every reader checks === 'true' or truthiness; this used to write
        // the STRING 'false', which is truthy, so the "close" hotkey left
        // both compose dialogs (open={!!isComposeOpen}) OPEN while flipping
        // the exact-match readers to closed — a half-closed zombie state.
        setIsComposeOpen(null);
      }
    },
  };

  const composeShortcuts = enhancedKeyboardShortcuts.filter((shortcut) => shortcut.scope === scope);

  useShortcuts(composeShortcuts, handlers, { scope });

  return null;
}
