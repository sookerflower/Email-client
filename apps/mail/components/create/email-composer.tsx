import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { Check, Command, Loader, Paperclip, Plus, Type, X as XIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScheduleSendPicker } from './schedule-send-picker';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { useEmailAliases } from '@/hooks/use-email-aliases';
import useComposeEditor from '@/hooks/use-compose-editor';
import { CurvedArrow, Sparkles, X } from '../icons/icons';
import { gitHubEmojis } from '@tiptap/extension-emoji';
import { zodResolver } from '@hookform/resolvers/zod';

import { useTRPC } from '@/providers/query-provider';
import { useMutation } from '@tanstack/react-query';
import { useSettings } from '@/hooks/use-settings';

import { cn, formatFileSize } from '@/lib/utils';
import {
  initialDraftSaveState,
  reduceDraftSave,
  type DraftSaveEvent,
} from '@/lib/draft-autosave';
import { useThread } from '@/hooks/use-threads';
import { serializeFiles } from '@/lib/schemas';
import { Input } from '@/components/ui/input';
import { EditorContent } from '@tiptap/react';
import { useForm } from 'react-hook-form';
import { useBlocker } from 'react-router';
import { Button } from '../ui/button';
import { useQueryState } from 'nuqs';
import { Toolbar } from './toolbar';
import pluralize from 'pluralize';
import { toast } from 'sonner';
import { z } from 'zod';

import { RecipientAutosuggest } from '@/components/ui/recipient-autosuggest';
import { ImageCompressionSettings } from './image-compression-settings';
import { compressImages } from '@/lib/image-compression';
import type { ImageQuality } from '@/lib/image-compression';

const shortcodeRegex = /:([a-zA-Z0-9_+-]+):/g;

/**
 * When the last MANUAL draft save succeeded. Module-scoped on purpose: a
 * successful save rotates the draft id, and create-email keys the composer
 * by draft id, so the whole component REMOUNTS right after saving — state
 * inside the instance cannot carry the "Saved" indicator across that
 * boundary. The flash reads this on mount and shows for the remainder.
 */
let lastManualDraftSaveAt = 0;
const SAVED_FLASH_MS = 2500;
import { TemplateButton } from './template-button';

type ThreadContent = {
  from: string;
  to: string[];
  body: string;
  cc?: string[];
  subject: string;
}[];

interface EmailComposerProps {
  initialTo?: string[];
  initialCc?: string[];
  initialBcc?: string[];
  initialSubject?: string;
  initialMessage?: string;
  initialAttachments?: File[];
  replyingTo?: string;
  onSendEmail: (data: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    message: string;
    attachments: File[];
    fromEmail?: string;
    scheduleAt?: string;
  }) => Promise<void>;
  onClose?: () => void;
  className?: string;
  autofocus?: boolean;
  settingsLoading?: boolean;
  editorClassName?: string;
  /**
   * Close-guard hook for a WRAPPING dialog (create-email's esc/X close):
   * the parent calls the installed function before closing; it returns true
   * when closing is safe (nothing unsaved) and otherwise opens the blocking
   * Save/Discard/Cancel dialog and returns false.
   */
  closeGuardRef?: MutableRefObject<(() => boolean) | null>;
}



const schema = z.object({
  to: z.array(z.string().email()).min(1),
  subject: z.string().min(1),
  message: z.string().min(1),
  attachments: z.array(z.any()).optional(),
  headers: z.any().optional(),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  threadId: z.string().optional(),
  fromEmail: z.string().optional(),
});

export function EmailComposer({
  initialTo = [],
  initialCc = [],
  initialBcc = [],
  initialSubject = '',
  initialMessage = '',
  initialAttachments = [],
  onSendEmail,
  onClose,
  className,
  autofocus = false,
  settingsLoading = false,
  editorClassName,
  closeGuardRef,
}: EmailComposerProps) {
  const { data: aliases } = useEmailAliases();
  const { data: settings } = useSettings();
  const [showCc, setShowCc] = useState(initialCc.length > 0);
  const [showBcc, setShowBcc] = useState(initialBcc.length > 0);
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  // All dirty/failure transitions go through the draft-save reducer
  // (lib/draft-autosave.ts) so the "failure keeps the compose dirty"
  // invariant lives in tested code. `hasUnsavedChanges` mirrors
  // `draftSaveState.current.dirty` for rendering. Saving is MANUAL-only:
  // no timer exists; saveDraft runs from the user's explicit actions.
  const draftSaveState = useRef(initialDraftSaveState);
  const applyDraftSave = (event: DraftSaveEvent) => {
    draftSaveState.current = reduceDraftSave(draftSaveState.current, event);
    setHasUnsavedChanges(draftSaveState.current.dirty);
  };
  /** Every user-edit path funnels here: marks dirty, resets save failures. */
  const markUnsaved = () => applyDraftSave({ type: 'edit' });
  const [messageLength, setMessageLength] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [threadId] = useQueryState('threadId');
  const [isComposeOpen, setIsComposeOpen] = useQueryState('isComposeOpen');
  const { data: emailData } = useThread(threadId ?? null);
  const [draftId, setDraftId] = useQueryState('draftId');
  const [aiGeneratedMessage, setAiGeneratedMessage] = useState<string | null>(null);
  const [aiIsLoading, setAiIsLoading] = useState(false);
  const [isGeneratingSubject, setIsGeneratingSubject] = useState(false);
  const [showLeaveConfirmation, setShowLeaveConfirmation] = useState(false);
  const [scheduleAt, setScheduleAt] = useState<string>();
  const [isScheduleValid, setIsScheduleValid] = useState<boolean>(true);
  const [showAttachmentWarning, setShowAttachmentWarning] = useState(false);
  const [originalAttachments, setOriginalAttachments] = useState<File[]>(initialAttachments);
  const [imageQuality, setImageQuality] = useState<ImageQuality>(
    settings?.settings?.imageCompression || 'medium',
  );
  const [activeReplyId] = useQueryState('activeReplyId');
  const [toggleToolbar, setToggleToolbar] = useState(false);
  const processAndSetAttachments = async (
    filesToProcess: File[],
    quality: ImageQuality,
    showToast: boolean = false,
  ) => {
    if (filesToProcess.length === 0) {
      setValue('attachments', [], { shouldDirty: true });
      return;
    }

    try {
      const compressedFiles = await compressImages(filesToProcess, {
        quality,
        maxWidth: 1920,
        maxHeight: 1080,
      });

      if (compressedFiles.length !== filesToProcess.length) {
        console.warn('Compressed files array length mismatch:', {
          original: filesToProcess.length,
          compressed: compressedFiles.length,
        });
        setValue('attachments', filesToProcess, { shouldDirty: true });
        markUnsaved();
        if (showToast) {
          toast.error('Image compression failed, using original files');
        }
        return;
      }

      setValue('attachments', compressedFiles, { shouldDirty: true });
      markUnsaved();

      if (showToast && quality !== 'original') {
        let totalOriginalSize = 0;
        let totalCompressedSize = 0;

        const imageFilesExist = filesToProcess.some((f) => f.type.startsWith('image/'));

        if (imageFilesExist) {
          filesToProcess.forEach((originalFile, index) => {
            if (originalFile.type.startsWith('image/') && compressedFiles[index]) {
              totalOriginalSize += originalFile.size;
              totalCompressedSize += compressedFiles[index].size;
            }
          });

          if (totalOriginalSize > totalCompressedSize) {
            const savings = (
              ((totalOriginalSize - totalCompressedSize) / totalOriginalSize) *
              100
            ).toFixed(1);
            if (parseFloat(savings) > 0.1) {
              toast.success(`Images compressed: ${savings}% smaller`);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error compressing images:', error);
      setValue('attachments', filesToProcess, { shouldDirty: true });
      markUnsaved();
      if (showToast) {
        toast.error('Image compression failed, using original files');
      }
    }
  };

  const attachmentKeywords = [
    'attachment',
    'attached',
    'attaching',
    'see the file',
    'see the files',
  ];

  const trpc = useTRPC();
  const { mutateAsync: aiCompose } = useMutation(trpc.ai.compose.mutationOptions());
  const { mutateAsync: createDraft } = useMutation(trpc.drafts.create.mutationOptions());
  const { mutateAsync: generateEmailSubject } = useMutation(
    trpc.ai.generateEmailSubject.mutationOptions(),
  );

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      to: initialTo,
      cc: initialCc,
      bcc: initialBcc,
      subject: initialSubject,
      message: initialMessage,
      attachments: initialAttachments,
      fromEmail:
        settings?.settings?.defaultEmailAlias ||
        aliases?.find((alias) => alias.primary)?.email ||
        aliases?.[0]?.email ||
        '',
    },
  });

  const { watch, setValue, getValues } = form;
  const toEmails = watch('to');
  const ccEmails = watch('cc');
  const bccEmails = watch('bcc');
  const subjectInput = watch('subject');
  const attachments = watch('attachments');
  const fromEmail = watch('fromEmail');
  // Initialized from the module-scoped timestamp so the indicator survives
  // the remount a successful save causes (see lastManualDraftSaveAt).
  const [showSavedFlash, setShowSavedFlash] = useState(
    () => Date.now() - lastManualDraftSaveAt < SAVED_FLASH_MS,
  );
  const savedFlashTimer = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    const remaining = SAVED_FLASH_MS - (Date.now() - lastManualDraftSaveAt);
    if (remaining > 0) {
      savedFlashTimer.current = setTimeout(() => setShowSavedFlash(false), remaining);
    }
    return () => {
      if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
    };
  }, []);

  const handleAttachment = async (newFiles: File[]) => {
    if (newFiles && newFiles.length > 0) {
      const newOriginals = [...originalAttachments, ...newFiles];
      setOriginalAttachments(newOriginals);
      await processAndSetAttachments(newOriginals, imageQuality, true);
    }
  };

  const removeAttachment = async (index: number) => {
    const newOriginals = originalAttachments.filter((_, i) => i !== index);
    setOriginalAttachments(newOriginals);
    await processAndSetAttachments(newOriginals, imageQuality);
    markUnsaved();
  };

  const editor = useComposeEditor({
    initialValue: initialMessage,
    isReadOnly: isLoading,
    onLengthChange: (length) => {
      markUnsaved();
      setMessageLength(length);
    },
    onModEnter: () => {
      void handleSend();
      return true;
    },
    onAttachmentsChange: async (files) => {
      await handleAttachment(files);
    },
    placeholder: 'Start your email here',
    autofocus,
  });

  // Manual saving is enabled as soon as ANY field has content — deliberately
  // NOT the send-style completeness rule. The body check asks the editor
  // directly rather than trusting `messageLength`: that state only updates
  // on EDITS (the hook's onCreate init is commented out), so a composer
  // remount with a full body — which happens when the first save writes
  // draftId into the URL — would otherwise report "no content" and disable
  // the Save button right after a successful save.
  const editorHasText = (editor?.getText().trim().length ?? 0) > 0;
  const hasAnyComposeContent =
    (toEmails?.length ?? 0) > 0 ||
    (ccEmails?.length ?? 0) > 0 ||
    (bccEmails?.length ?? 0) > 0 ||
    (subjectInput?.trim().length ?? 0) > 0 ||
    messageLength > 0 ||
    editorHasText ||
    (attachments?.length ?? 0) > 0;

  // Add effect to focus editor when component mounts
  useEffect(() => {
    if (autofocus && editor) {
      const timeoutId = setTimeout(() => {
        editor.commands.focus('end');
      }, 100);
      return () => clearTimeout(timeoutId);
    }
  }, [editor, autofocus]);

  // Remove the TRPC query - we'll use the component's internal logic instead
  useEffect(() => {
    if (isComposeOpen === 'true' && editor) {
      editor.commands.focus();
    }
  }, [isComposeOpen, editor]);

  // Prevent browser navigation/refresh when there's unsaved content
  useEffect(() => {
    if (!editor) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const hasContent = editor?.getText()?.trim().length > 0;
      if (hasContent) {
        e.preventDefault();
        e.returnValue = ''; // Required for Chrome
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [editor]);

  // Perhaps add `hasUnsavedChanges` to the condition
  useEffect(() => {
    if (!editor) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const hasContent = editor?.getText()?.trim().length > 0;
        if (hasContent && !draftId) {
          e.preventDefault();
          e.stopPropagation();
          setShowLeaveConfirmation(true);
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true); // Use capture phase
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [editor, draftId]);

  const proceedWithSend = async () => {
    try {
      if (isLoading || isSavingDraft) return;

      const values = getValues();

      // Validate recipient field
      if (!values.to || values.to.length === 0) {
        toast.error('Recipient is required');
        return;
      }

      if (!isScheduleValid) {
        toast.error('Please choose a valid date & time for scheduling');
        return;
      }

      setIsLoading(true);
      setAiGeneratedMessage(null);
      // Save draft before sending, we want to send drafts instead of sending new emails
      if (hasUnsavedChanges) await saveDraft();

      await onSendEmail({
        to: values.to,
        cc: showCc ? values.cc : undefined,
        bcc: showBcc ? values.bcc : undefined,
        subject: values.subject,
        message: editor.getHTML(),
        attachments: values.attachments || [],
        fromEmail: values.fromEmail,
        scheduleAt,
      });
      // Content persisted via the send path: clean state through the reducer.
      applyDraftSave({ type: 'save-success' });
      editor.commands.clearContent(true);
      form.reset();
      setIsComposeOpen(null);
    } catch (error) {
      console.error('Error sending email:', error);
      toast.error('Failed to send email');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = async () => {
    const values = getValues();
    const messageText = editor.getText().toLowerCase();
    const hasAttachmentKeywords = attachmentKeywords.some((keyword) => {
      const regex = new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}\\b`, 'i');
      return regex.test(messageText);
    });

    if (hasAttachmentKeywords && (!values.attachments || values.attachments.length === 0)) {
      setShowAttachmentWarning(true);
      return;
    }

    await proceedWithSend();
  };

  const threadContent: ThreadContent = useMemo(() => {
    if (!emailData) return [];
    return emailData.messages.map((message) => {
      return {
        body: message.decodedBody ?? '',
        from: message.sender.name ?? message.sender.email,
        to: message.to.reduce<string[]>((to, recipient) => {
          if (recipient.name) {
            to.push(recipient.name);
          }
          return to;
        }, []),
        cc: message.cc?.reduce<string[]>((cc, recipient) => {
          if (recipient.name) {
            cc.push(recipient.name);
          }
          return cc;
        }, []),
        subject: message.subject,
      };
    });
  }, [emailData]);

  const handleAiGenerate = async () => {
    try {
      setIsLoading(true);
      setAiIsLoading(true);
      const values = getValues();

      const result = await aiCompose({
        prompt: editor.getText(),
        emailSubject: values.subject,
        to: values.to,
        cc: values.cc,
        threadMessages: threadContent,
      });

      setAiGeneratedMessage(result.newBody);
      // toast.success('Email generated successfully');
    } catch (error) {
      console.error('Error generating AI email:', error);
      toast.error('Failed to generate email');
    } finally {
      setIsLoading(false);
      setAiIsLoading(false);
    }
  };

  /**
   * Persist the compose as a draft (IMAP APPEND to the Drafts folder).
   *
   * `manual: true` is the explicit user action (Save draft button, Cmd+S,
   * the close guard): it saves whatever content exists — the historical
   * recipient+subject+body completeness gate was right for automatic
   * saving and wrong for manual (three typed lines with no subject and no
   * recipient MUST save when the user asks). The implicit send-path call
   * keeps the historical gates.
   */
  /** Returns true when the compose is persisted (or there was nothing to
   *  persist) — the close guard closes only on true. */
  const saveDraft = async ({ manual = false }: { manual?: boolean } = {}): Promise<boolean> => {
    if (isSavingDraft) return false;
    const values = getValues();
    const messageText = editor.getText();

    if (manual) {
      // Explicit action: only bail when there is literally nothing to save.
      if (!hasAnyComposeContent) return true;
    } else {
      if (!hasUnsavedChanges) return true;
      if (messageText.trim() === initialMessage.trim()) return true;
      if (editor.getHTML() === initialMessage.trim()) return true;
      if (!values.to.length || !values.subject.length || !messageText.length) return true;
      if (aiGeneratedMessage || aiIsLoading || isGeneratingSubject) return true;
    }

    try {
      setIsSavingDraft(true);
      const draftData = {
        to: values.to.join(', '),
        cc: values.cc?.join(', '),
        bcc: values.bcc?.join(', '),
        subject: values.subject,
        message: editor.getHTML(),
        bodyType: 'html' as const,
        attachments: await serializeFiles(values.attachments ?? []),
        id: draftId,
        threadId: threadId ? threadId : null,
        fromEmail: values.fromEmail ? values.fromEmail : null,
      };

      const response = await createDraft(draftData);

      if (response?.id && response.id !== draftId) {
        setDraftId(response.id);
      }
      // SUCCESS is the only outcome that marks the compose clean. This
      // used to happen in catch AND finally too, so a single failed save
      // marked the content "saved" and the text was silently lost unless
      // the send succeeded.
      applyDraftSave({ type: 'save-success' });
      if (manual) {
        lastManualDraftSaveAt = Date.now();
        setShowSavedFlash(true);
        if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
        savedFlashTimer.current = setTimeout(() => setShowSavedFlash(false), SAVED_FLASH_MS);
      }
      return true;
    } catch (error) {
      console.error('Error saving draft:', error);
      applyDraftSave({ type: 'save-failure' });
      // Manual model: no automatic retry (the user retries by clicking;
      // hammering a failing IMAP server is the fail2ban shape). Surface
      // every failure — each one is a user-initiated action that lost.
      toast.error('Failed to save draft — your changes are still unsaved');
      return false;
    } finally {
      setIsSavingDraft(false);
    }
  };

  const handleGenerateSubject = async () => {
    try {
      setIsGeneratingSubject(true);
      const messageText = editor.getText().trim();

      if (!messageText) {
        toast.error('Please enter some message content first');
        return;
      }

      const { subject } = await generateEmailSubject({ message: messageText });
      setValue('subject', subject);
      // Deliberately NO dirty-marking here. Under the manual-save model
      // nothing persists without an explicit user action anyway, and a
      // generated subject alone is not user content — "click generate,
      // walk away" must leave no draft behind. (The autosave-era
      // suppression event this replaced is gone with the timer.)
    } catch (error) {
      console.error('Error generating subject:', error);
      toast.error('Failed to generate subject');
    } finally {
      setIsGeneratingSubject(false);
    }
  };

  // ---- Close guard (manual-save model) -----------------------------------
  // Closing a composer with UNSAVED content must go through a blocking
  // Save draft / Discard / Cancel dialog — on the internal X, on the
  // wrapping dialog's esc/X (via closeGuardRef), and on route navigation
  // (via useBlocker below). `pendingCloseRef` records what the user was
  // trying to do so the chosen button can complete or cancel exactly that.
  const pendingCloseRef = useRef<'close' | ReturnType<typeof useBlocker> | null>(null);

  const resolvePendingClose = (action: 'proceed' | 'reset') => {
    const pending = pendingCloseRef.current;
    pendingCloseRef.current = null;
    if (pending === 'close' || pending == null) {
      if (action === 'proceed') onClose?.();
    } else if (action === 'proceed') {
      pending.proceed?.();
    } else {
      pending.reset?.();
    }
  };

  const handleClose = () => {
    if (draftSaveState.current.dirty) {
      pendingCloseRef.current = 'close';
      setShowLeaveConfirmation(true);
    } else {
      onClose?.();
    }
  };

  // Guard: Save draft, then complete the close/navigation — a FAILED save
  // keeps the guard open (the toast explains; nothing is lost).
  const saveAndLeave = async () => {
    const saved = await saveDraft({ manual: true });
    if (!saved) return;
    setShowLeaveConfirmation(false);
    resolvePendingClose('proceed');
  };

  // Guard: Discard = leave WITHOUT saving. Writes nothing; deliberately
  // does not delete drafts the user explicitly saved earlier (or opened
  // from the Drafts folder) — discarding drops the unsaved EDITS, it does
  // not destroy previously persisted mail. A never-saved compose leaves
  // nothing behind on the server because nothing was ever written.
  const discardAndLeave = () => {
    setShowLeaveConfirmation(false);
    resolvePendingClose('proceed');
  };

  const cancelLeave = () => {
    setShowLeaveConfirmation(false);
    resolvePendingClose('reset');
  };

  // Wrapping-dialog guard (create-email's esc/X): returns true when closing
  // is safe, else opens the blocking dialog and returns false.
  useEffect(() => {
    if (!closeGuardRef) return;
    closeGuardRef.current = () => {
      if (!draftSaveState.current.dirty) return true;
      pendingCloseRef.current = 'close';
      setShowLeaveConfirmation(true);
      return false;
    };
    return () => {
      closeGuardRef.current = null;
    };
  }, [closeGuardRef]);

  // Route-navigation guard: leaving the page with unsaved content blocks
  // and opens the same dialog.
  const navBlocker = useBlocker(hasUnsavedChanges);
  useEffect(() => {
    if (navBlocker.state === 'blocked') {
      pendingCloseRef.current = navBlocker;
      setShowLeaveConfirmation(true);
    }
  }, [navBlocker, navBlocker.state]);

  // Component unmount protection
  useEffect(() => {
    return () => {
      // This cleanup runs when component is about to unmount
      const hasContent = editor?.getText()?.trim().length > 0;
      if (hasContent && !showLeaveConfirmation) {
        // If we have content and haven't shown confirmation, it means
        // the component is being unmounted unexpectedly
        console.warn('Email composer unmounting with unsaved content');
      }
    };
  }, [editor, showLeaveConfirmation]);

  // Drafts save MANUALLY only (Save draft button / Cmd+S / send path /
  // close guard). The 3-second autosave timer that used to live here is
  // deliberately gone — saving happens when the user asks, not on a clock.

  // Cmd/Ctrl+S — same action as the Save draft button. preventDefault stops
  // the browser's own save dialog even when there is nothing to save.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveDraft({ manual: true });
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [saveDraft]);

  useEffect(() => {
    const handlePasteFiles = (event: ClipboardEvent) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData || !clipboardData.files.length) return;

      const pastedFiles = Array.from(clipboardData.files);
      if (pastedFiles.length > 0) {
        event.preventDefault();
        handleAttachment(pastedFiles);
        toast.success(`${pluralize('file', pastedFiles.length, true)} attached`);
      }
    };

    document.addEventListener('paste', handlePasteFiles);
    return () => {
      document.removeEventListener('paste', handlePasteFiles);
    };
  }, [handleAttachment]);

  // useHotkeys('meta+y', async (e) => {
  //   if (!editor.getText().trim().length && !subjectInput.trim().length) {
  //     toast.error('Please enter a subject or a message');
  //     return;
  //   }
  //   if (!subjectInput.trim()) {
  //     await handleGenerateSubject();
  //   }
  //   setAiGeneratedMessage(null);
  //   await handleAiGenerate();
  // });


  // keep fromEmail in sync when settings or aliases load afterwards
  useEffect(() => {
    const preferred =
      settings?.settings?.defaultEmailAlias ??
      aliases?.find((a) => a.primary)?.email ??
      aliases?.[0]?.email;

    if (preferred && getValues('fromEmail') !== preferred) {
      setValue('fromEmail', preferred, { shouldDirty: false });
    }
  }, [settings?.settings?.defaultEmailAlias, aliases, getValues, setValue]);

  const handleQualityChange = async (newQuality: ImageQuality) => {
    setImageQuality(newQuality);
    await processAndSetAttachments(originalAttachments, newQuality, true);
  };

  const handleScheduleChange = useCallback((value?: string) => {
    setScheduleAt(value);
  }, []);

  const handleScheduleValidityChange = useCallback((valid: boolean) => {
    setIsScheduleValid(valid);
  }, []);

  const replaceEmojiShortcodes = (text: string): string => {
    if (!text.trim().length || !text.includes(':')) return text;
    return text.replace(shortcodeRegex, (match, shortcode): string => {
      const emoji = gitHubEmojis.find(
        (e) => e.shortcodes.includes(shortcode) || e.name === shortcode,
      );
      return emoji?.emoji ?? match;
    });
  };

  return (
    <div
      className={cn(
        'flex max-h-[500px] w-full max-w-[750px] flex-col overflow-hidden rounded-2xl bg-[#FAFAFA] shadow-sm dark:bg-[#202020]',
        className,
      )}
    >
      <div className="no-scrollbar bg-ax-surface flex min-h-0 flex-1 flex-col overflow-y-auto rounded-2xl">
        {/* To, Cc, Bcc */}
        <div className="shrink-0 overflow-visible border-b border-ax-border-subtle pb-2">
          <div className="flex justify-between px-3 pt-3">
            <div className="flex w-full items-center gap-2">
              <p className="ax-type-ui font-[var(--ax-weight-medium)] text-ax-tertiary">To:</p>
              <RecipientAutosuggest
                control={form.control}
                name="to"
                placeholder="Enter email address"
                disabled={isLoading}
              />
            </div>

            <div className="flex gap-2">
              <button
                tabIndex={-1}
                className="ax-pressable ax-type-ui flex h-full cursor-pointer items-center gap-2 rounded-[4px] px-1 py-0.5 font-[var(--ax-weight-medium)] text-ax-tertiary transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-hover hover:text-ax-primary"
                onClick={() => setShowCc(!showCc)}
              >
                <span>Cc</span>
              </button>
              <button
                tabIndex={-1}
                className="ax-pressable ax-type-ui flex h-full cursor-pointer items-center gap-2 rounded-[4px] px-1 py-0.5 font-[var(--ax-weight-medium)] text-ax-tertiary transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-hover hover:text-ax-primary"
                onClick={() => setShowBcc(!showBcc)}
              >
                <span>Bcc</span>
              </button>
              {onClose && (
                <button
                  tabIndex={-1}
                  className="ax-pressable ax-type-ui flex h-full cursor-pointer items-center gap-2 rounded-[4px] px-1 py-0.5 font-[var(--ax-weight-medium)] text-ax-tertiary transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-hover hover:text-ax-primary"
                  onClick={handleClose}
                >
                  <X className="h-3.5 w-3.5 fill-ax-tertiary" />
                </button>
              )}
            </div>
          </div>

          <div className={`flex flex-col gap-2 ${showCc || showBcc ? 'pt-2' : ''}`}>
            {/* CC Section */}
            {showCc && (
              <div className="flex items-center gap-2 px-3">
                <p className="ax-type-ui font-[var(--ax-weight-medium)] text-ax-tertiary">Cc:</p>
                <RecipientAutosuggest
                  control={form.control}
                  name="cc"
                  placeholder="Enter email for Cc"
                  disabled={isLoading}
                />
              </div>
            )}

            {/* BCC Section */}
            {showBcc && (
              <div className="flex items-center gap-2 px-3">
                <p className="ax-type-ui font-[var(--ax-weight-medium)] text-ax-tertiary">Bcc:</p>
                <RecipientAutosuggest
                  control={form.control}
                  name="bcc"
                  placeholder="Enter email for Bcc"
                  disabled={isLoading}
                />
              </div>
            )}
          </div>
        </div>

        {/* Subject */}
        {!activeReplyId ? (
          <div className="flex items-center gap-2 border-b p-3">
            <p className="ax-type-ui font-[var(--ax-weight-medium)] text-ax-tertiary">Subject:</p>
            <input
              className="ax-type-ui h-4 w-full bg-transparent text-ax-primary placeholder:text-ax-tertiary focus:outline-none"
              placeholder="Re: Design review feedback"
              value={subjectInput}
              onChange={(e) => {
                const value = replaceEmojiShortcodes(e.target.value);
                setValue('subject', value);
                markUnsaved();
              }}
            />
            <button
              onClick={handleGenerateSubject}
              disabled={isLoading || isGeneratingSubject || messageLength < 1}
              className="ax-pressable cursor-pointer rounded-[4px] p-1 transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-hover"
            >
              <div className="flex items-center justify-center gap-2.5 pl-0.5">
                <div className="flex h-5 items-center justify-center gap-1 rounded-sm">
                  {isGeneratingSubject ? (
                    <Loader className="h-3.5 w-3.5 animate-spin fill-ax-secondary" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 fill-ax-accent" />
                  )}
                </div>
              </div>
            </button>
          </div>
        ) : null}

        {/* From */}
        {aliases && aliases.length > 1 ? (
          <div className="flex items-center gap-2 border-b p-3">
            <p className="ax-type-ui font-[var(--ax-weight-medium)] text-ax-tertiary">From:</p>
            <Select
              value={fromEmail || ''}
              onValueChange={(value) => {
                setValue('fromEmail', value);
                markUnsaved();
              }}
            >
              <SelectTrigger className="ax-type-ui h-6 flex-1 border-0 bg-transparent p-0 text-ax-primary placeholder:text-ax-tertiary focus:outline-none focus:ring-0">
                <SelectValue placeholder="Select an email address" />
              </SelectTrigger>
              <SelectContent className="z-99999">
                {aliases.map((alias) => (
                  <SelectItem key={alias.email} value={alias.email}>
                    <div className="flex flex-row items-center gap-1">
                      <span className="text-sm">
                        {alias.name ? `${alias.name} <${alias.email}>` : alias.email}
                      </span>
                      {alias.primary && <span className="ax-type-small text-ax-tertiary">Primary</span>}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {/* Message Content */}
        <div className="flex-1 overflow-y-auto border-t border-ax-border-subtle bg-ax-surface px-3 py-3">
          <div
            onClick={() => {
              editor.commands.focus();
            }}
            className={cn(
              `min-h-[200px] w-full`,
              editorClassName,
              aiGeneratedMessage !== null ? 'blur-sm' : '',
            )}
          >
            <EditorContent editor={editor} className="h-full w-full max-w-full overflow-x-auto" />
          </div>
        </div>
      </div>

      {/* Bottom Actions */}
      <div className="inline-flex w-full shrink-0 items-end justify-between self-stretch rounded-b-2xl bg-ax-surface px-3 py-3">
        <div className="flex flex-col items-start justify-start gap-2">
          {toggleToolbar && <Toolbar editor={editor} />}
          <div className="flex items-center justify-start gap-2">
            <Button size={'xs'} onClick={handleSend} disabled={isLoading || settingsLoading || !isScheduleValid} className="ax-pressable rounded-ax-control bg-ax-accent text-ax-on-accent hover:bg-ax-accent-hover focus-visible:ring-2 focus-visible:ring-ax-ring">
              <div className="flex items-center justify-center">
                <div className="ax-type-ui text-center font-[var(--ax-weight-medium)] leading-none">
                  <span>Send </span>
                </div>
              </div>
              <div className="flex h-5 items-center justify-center gap-1 rounded-sm bg-[var(--ax-on-accent)]/10 px-1">
                <Command className="h-3.5 w-3.5 text-current" />
                <CurvedArrow className="mt-1.5 h-4 w-4 fill-current" />
              </div>
            </Button>
            <ScheduleSendPicker
              value={scheduleAt}
              onChange={handleScheduleChange}
              onValidityChange={handleScheduleValidityChange}
            />
            {/* Save draft: always rendered while composing; enabled as soon
                as ANY field has content (manual saving has no completeness
                gate). Repeated clicks update the same draft via draftId. */}
            <Button
              variant={'secondary'}
              size={'xs'}
              onClick={() => void saveDraft({ manual: true })}
              disabled={isSavingDraft || !hasAnyComposeContent}
              className="ax-pressable rounded-ax-control border border-ax-border bg-ax-raised text-ax-primary transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-overlay focus-visible:ring-2 focus-visible:ring-ax-ring cursor-pointer"
            >
              <span className="ax-type-ui px-0.5">{isSavingDraft ? 'Saving…' : 'Save draft'}</span>
            </Button>
            {showSavedFlash ? (
              <span aria-live="polite" className="ax-type-ui text-ax-success">
                Saved
              </span>
            ) : null}
            <Button variant={'secondary'} size={'xs'} onClick={() => fileInputRef.current?.click()} className="ax-pressable rounded-ax-control border border-ax-border bg-ax-raised text-ax-primary transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-overlay focus-visible:ring-2 focus-visible:ring-ax-ring cursor-pointer">
              <Plus className="h-3 w-3 fill-ax-tertiary" />
              <span className="hidden px-0.5 text-sm md:block">Add</span>
            </Button>
            <TemplateButton
              editor={editor}
              subject={subjectInput}
              setSubject={(value) => setValue('subject', value)}
              to={toEmails}
              cc={ccEmails ?? []}
              bcc={bccEmails ?? []}
              setRecipients={(field, val) => setValue(field, val)}
            />
            <Input
              type="file"
              id="attachment-input"
              className="hidden"
              onChange={async (event) => {
                const fileList = event.target.files;
                if (fileList) {
                  await handleAttachment(Array.from(fileList));
                }
              }}
              multiple
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
              ref={fileInputRef}
              style={{ zIndex: 100 }}
            />
            {attachments && attachments.length > 0 && (
              <Popover modal={true}>
                <PopoverTrigger asChild>
                  <button
                    className="ax-pressable ax-type-ui flex cursor-pointer items-center gap-1.5 rounded-ax-control border border-ax-border bg-ax-raised px-2 py-1 text-ax-primary transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring"
                    aria-label={`View ${attachments.length} attached ${pluralize('file', attachments.length)}`}
                  >
                    <Paperclip className="h-3.5 w-3.5 text-ax-tertiary" />
                    <span className="font-medium">{attachments.length}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  className="z-100 w-[340px] rounded-ax-surface border-ax-border bg-ax-overlay p-0 shadow-ax-popover"
                  align="start"
                  sideOffset={6}
                >
                  <div className="flex flex-col">
                    <div className="border-b border-ax-border-subtle p-3">
                      <h4 className="ax-type-ui font-[var(--ax-weight-semibold)] text-ax-primary">
                        Attachments
                      </h4>
                      <p className="ax-type-small text-ax-tertiary">
                        {pluralize('file', attachments.length, true)}
                      </p>
                    </div>

                    <div className="border-b border-ax-border-subtle p-3">
                      <ImageCompressionSettings
                        quality={imageQuality}
                        onQualityChange={handleQualityChange}
                        className="border-0 shadow-none"
                      />
                    </div>

                    <div className="max-h-[250px] flex-1 space-y-0.5 overflow-y-auto p-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {attachments.map((file: File, index: number) => {
                        const nameParts = file.name.split('.');
                        const extension = nameParts.length > 1 ? nameParts.pop() : undefined;
                        const nameWithoutExt = nameParts.join('.');
                        const maxNameLength = 22;
                        const truncatedName =
                          nameWithoutExt.length > maxNameLength
                            ? `${nameWithoutExt.slice(0, maxNameLength)}…`
                            : nameWithoutExt;
                        return (
                          <div
                            key={file.name + index}
                            className="group flex items-center justify-between gap-3 rounded-ax-control px-1.5 py-1.5 hover:bg-ax-hover"
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-3">
                              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-ax-raised">
                                {file.type.startsWith('image/') ? (
                                  <img
                                    src={URL.createObjectURL(file)}
                                    alt={file.name}
                                    className="h-full w-full rounded object-cover"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <span className="text-sm" aria-hidden="true">
                                    {file.type.includes('pdf')
                                      ? '📄'
                                      : file.type.includes('excel') ||
                                          file.type.includes('spreadsheetml')
                                        ? '📊'
                                        : file.type.includes('word') ||
                                            file.type.includes('wordprocessingml')
                                          ? '📝'
                                          : '📎'}
                                  </span>
                                )}
                              </div>
                              <div className="flex min-w-0 flex-1 flex-col">
                                <p
                                  className="ax-type-ui flex items-baseline text-ax-primary"
                                  title={file.name}
                                >
                                  <span className="truncate">{truncatedName}</span>
                                  {extension && (
                                    <span className="ax-type-micro ml-0.5 shrink-0 text-ax-tertiary">
                                      .{extension}
                                    </span>
                                  )}
                                </p>
                                <p className="ax-type-small text-ax-tertiary">
                                  {formatFileSize(file.size)}
                                </p>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={async (e: React.MouseEvent<HTMLButtonElement>) => {
                                e.preventDefault();
                                e.stopPropagation();

                                try {
                                  await removeAttachment(index);
                                } catch (error) {
                                  console.error('Failed to remove attachment:', error);
                                  toast.error('Failed to remove attachment');
                                }
                              }}
                              className="ax-pressable ml-1 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full bg-transparent hover:bg-ax-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring"
                              aria-label={`Remove ${file.name}`}
                            >
                              <XIcon className="h-3.5 w-3.5 text-ax-tertiary hover:text-ax-primary" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    tabIndex={-1}
                    variant="ghost"
                    size="icon"
                    onClick={() => setToggleToolbar(!toggleToolbar)}
                    className={`ax-pressable h-auto w-auto rounded-ax-control p-1.5 ${toggleToolbar ? 'bg-ax-active' : 'bg-ax-raised'} cursor-pointer border border-ax-border transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-overlay`}
                  >
                    <Type className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Formatting options</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
        <div className="flex items-start justify-start gap-2">
          <div className="relative">
            {aiGeneratedMessage !== null ? (
                <ContentPreview
                  content={aiGeneratedMessage}
                  onAccept={() => {
                    editor.commands.setContent({
                      type: 'doc',
                      content: aiGeneratedMessage.split(/\r?\n/).map((line) => {
                        return {
                          type: 'paragraph',
                          content: line.trim().length === 0 ? [] : [{ type: 'text', text: line }],
                        };
                      }),
                    });
                    setAiGeneratedMessage(null);
                    // ACCEPTING is a user edit: it must mark dirty (and lift
                    // any subject-generation suppression) EXPLICITLY.
                    // setContent() does not emit a tiptap update, so the
                    // editor's onLengthChange never fires here — pre-fix the
                    // accept flow only autosaved because subject generation
                    // had force-marked the compose dirty.
                    markUnsaved();
                  }}
                  onReject={() => {
                    setAiGeneratedMessage(null);
                  }}
                />
            ) : null}
            <Button
              size={'xs'}
              variant={'ghost'}
              className="ax-pressable cursor-pointer rounded-ax-control border border-ax-border bg-ax-raised text-ax-primary hover:bg-ax-overlay focus-visible:ring-2 focus-visible:ring-ax-ring"
              onClick={async () => {
                if (!subjectInput.trim()) {
                  await handleGenerateSubject();
                }
                setAiGeneratedMessage(null);
                await handleAiGenerate();
              }}
              disabled={isLoading || aiIsLoading || messageLength < 1}
            >
              <div className="flex items-center justify-center gap-2.5 pl-0.5">
                <div className="flex h-5 items-center justify-center gap-1 rounded-sm">
                  {aiIsLoading ? (
                    <Loader className="h-3.5 w-3.5 animate-spin fill-ax-secondary" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 fill-ax-accent" />
                  )}
                </div>
                <div className="hidden text-center text-sm leading-none text-black md:block dark:text-white">
                  Generate
                </div>
              </div>
            </Button>
          </div>
        </div>
      </div>

      {/* Blocking close guard: fires on the X, on Escape, and on navigating
          away whenever the compose holds UNSAVED content. Dismissing the
          dialog itself (esc/overlay) is Cancel. */}
      <Dialog
        open={showLeaveConfirmation}
        onOpenChange={(open) => {
          if (!open) cancelLeave();
        }}
      >
        <DialogContent showOverlay className="z-99999 sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Save this draft?</DialogTitle>
            <DialogDescription>
              You have unsaved changes. Save them as a draft, discard them, or keep editing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={cancelLeave} className="ax-pressable cursor-pointer">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={discardAndLeave}
              className="ax-pressable cursor-pointer"
            >
              Discard
            </Button>
            <Button onClick={() => void saveAndLeave()} disabled={isSavingDraft} className="ax-pressable cursor-pointer">
              {isSavingDraft ? 'Saving…' : 'Save draft'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showAttachmentWarning} onOpenChange={setShowAttachmentWarning}>
        <DialogContent showOverlay className="z-99999 sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Attachment Warning</DialogTitle>
            <DialogDescription>
              Looks like you mentioned an attachment in your message, but there are no files
              attached. Are you sure you want to send this email?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={() => {
                setShowAttachmentWarning(false);
              }}
              className="cursor-pointer"
            >
              Recheck
            </Button>
            <Button
              onClick={() => {
                setShowAttachmentWarning(false);
                void proceedWithSend();
              }}
              className="cursor-pointer"
            >
              Send Anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


const ContentPreview = ({
  content,
  onAccept,
  onReject,
}: {
  content: string;
  onAccept?: (value: string) => void | Promise<void>;
  onReject?: () => void | Promise<void>;
}) => (
  /* Streamed AI text renders as CHUNK-level fades (each new line fades in at
     150ms), replacing the per-character blur TextEffect — the model streams
     in ~51 deltas, so per-character work was main-thread cost with no
     perceptible gain at that chunk rate. The card itself enters on the
     token panel entrance. */
  <div className="ax-panel-enter absolute bottom-full right-0 z-50 w-[400px] overflow-hidden rounded-ax-surface border border-ax-border bg-ax-overlay p-1 shadow-ax-popover">
    <div
      className="ax-type-ui max-h-60 min-h-[150px] overflow-auto rounded-md p-1 text-ax-primary"
      style={{
        scrollbarGutter: 'stable',
      }}
    >
      {content.split('\n').map((line, i) => {
        return (
          <div className="ax-chunk-enter whitespace-pre-wrap" key={i}>
            {line}
          </div>
        );
      })}
    </div>
    <div className="flex justify-end gap-2 p-2">
      <button
        className="ax-pressable ax-type-ui flex h-7 cursor-pointer items-center gap-1 overflow-hidden rounded-ax-control bg-ax-danger-muted px-2 text-ax-danger transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-danger/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring"
        onClick={async () => {
          if (onReject) {
            await onReject();
          }
        }}
      >
        <XIcon className="h-3.5 w-3.5" />
        <span>Reject</span>
      </button>
      <button
        className="ax-pressable ax-type-ui flex h-7 cursor-pointer items-center gap-1 overflow-hidden rounded-ax-control bg-ax-success-muted px-2 text-ax-success transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-success/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring"
        onClick={async () => {
          if (onAccept) {
            await onAccept(content);
          }
        }}
      >
        <Check className="h-3.5 w-3.5" />
        <span>Accept</span>
      </button>
    </div>
  </div>
);
