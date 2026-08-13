import {
  Archive,
  ArchiveX,
  Folders,
  Mail,
  Printer,
  Reply,
  Sparkles,
  Star,
  ThreeDots,
  Trash,
  X,
} from '../icons/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useOptimisticThreadState } from '@/components/mail/optimistic-thread-state';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOptimisticActions } from '@/hooks/use-optimistic-actions';
import { focusedIndexAtom } from '@/hooks/use-mail-navigation';
import { type ThreadDestination } from '@/lib/thread-actions';
import { handleUnsubscribe } from '@/lib/email-utils.client';
import { useThread, useThreads } from '@/hooks/use-threads';
import { useAISidebar } from '@/components/ui/ai-sidebar';
import { EmptyStateIcon } from '../icons/empty-state-svg';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ParsedMessage, Attachment } from '@/types';
import { MailDisplaySkeleton } from './mail-skeleton';
import { useIsMobile } from '@/hooks/use-mobile';
import { Button } from '@/components/ui/button';
import { cleanHtml } from '@/lib/email-utils';
import ReplyCompose from './reply-composer';
import { NotesPanel } from './note-panel';
import { cn, FOLDERS } from '@/lib/utils';
import { m } from '@/paraglide/messages';
import MailDisplay from './mail-display';
import { useParams } from 'react-router';
import { Inbox } from 'lucide-react';
import { useQueryState } from 'nuqs';
import { format } from 'date-fns';
import { useAtom } from 'jotai';
import { toast } from 'sonner';

const formatFileSize = (size: number) => {
  const sizeInMB = (size / (1024 * 1024)).toFixed(2);
  return sizeInMB === '0.00' ? '' : `${sizeInMB} MB`;
};

const cleanNameDisplay = (name?: string) => {
  if (!name) return '';
  return name.replace(/["<>]/g, '');
};

interface ThreadDisplayProps {
  threadParam?: any;
  onClose?: () => void;
  isMobile?: boolean;
  messages?: ParsedMessage[];
  id?: string;
}

export function ThreadDemo({ messages, isMobile }: ThreadDisplayProps) {
  const isFullscreen = false;
  return (
    <div
      className={cn(
        'flex flex-col',
        isFullscreen ? 'h-screen' : isMobile ? 'h-full' : 'h-[calc(100dvh-2rem)]',
      )}
    >
      <div
        className={cn(
          'bg-offsetLight dark:bg-offsetDark relative flex flex-col overflow-hidden duration-300',
          isMobile ? 'h-full' : 'h-full',
          !isMobile && !isFullscreen && 'rounded-r-lg',
          isFullscreen ? 'fixed inset-0 z-50' : '',
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ScrollArea className="flex-1" type="scroll">
            <div className="pb-4">
              {[...(messages || [])].reverse().map((message, index) => (
                <div
                  key={message.id}
                  className={cn('duration-200', index > 0 && 'border-ax-border-subtle border-t')}
                >
                  <MailDisplay
                    demo
                    emailData={message}
                    isFullscreen={isFullscreen}
                    isLoading={false}
                    index={index}
                  />
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}

function ThreadActionButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  className,
}: {
  icon: React.ComponentType<React.ComponentPropsWithRef<any>> & {
    startAnimation?: () => void;
    stopAnimation?: () => void;
  };
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const iconRef = useRef<any>(null);

  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            disabled={disabled}
            onClick={onClick}
            variant="ghost"
            className={cn('ax-pressable rounded-ax-control focus-visible:ring-2 focus-visible:ring-ax-ring md:h-fit md:px-2', className)}
            onMouseEnter={() => iconRef.current?.startAnimation?.()}
            onMouseLeave={() => iconRef.current?.stopAnimation?.()}
          >
            <Icon ref={iconRef} className="fill-ax-secondary" />
            <span className="sr-only">{label}</span>
          </Button>
        </TooltipTrigger>
        {/* <TooltipContent>{label}</TooltipContent> */}
      </Tooltip>
    </TooltipProvider>
  );
}
const isFullscreen = false;
export function ThreadDisplay() {
  const isMobile = useIsMobile();
  const { toggleOpen: toggleAISidebar } = useAISidebar();
  const params = useParams<{ folder: string }>();

  const folder = params?.folder ?? 'inbox';
  const [id, setThreadId] = useQueryState('threadId');
  const { data: emailData, isLoading } = useThread(id ?? null);
  const [, items] = useThreads();
  const [isStarred, setIsStarred] = useState(false);


  // Collect all attachments from all messages in the thread
  const allThreadAttachments = useMemo(() => {
    if (!emailData?.messages) return [];
    return emailData.messages.reduce<Attachment[]>((acc, message) => {
      if (message.attachments && message.attachments.length > 0) {
        acc.push(...message.attachments);
      }
      return acc;
    }, []);
  }, [emailData?.messages]);

  const [mode, setMode] = useQueryState('mode');
  const [activeReplyId, setActiveReplyId] = useQueryState('activeReplyId');
  const [, setDraftId] = useQueryState('draftId');

  const [focusedIndex, setFocusedIndex] = useAtom(focusedIndexAtom);
  const [, setIsComposeOpen] = useQueryState('isComposeOpen');

  // Get optimistic state for this thread
  const optimisticState = useOptimisticThreadState(id ?? '');

  const handleNext = useCallback(() => {
    if (!id || !items.length || focusedIndex === null) return setThreadId(null);
    if (focusedIndex < items.length - 1) {
      const nextIndex = Math.max(1, focusedIndex + 1);
      //   console.log('nextIndex', nextIndex);

      const nextThread = items[nextIndex];
      if (nextThread) {
        setMode(null);
        setActiveReplyId(null);
        setDraftId(null);
        setThreadId(nextThread.id);
        setFocusedIndex(focusedIndex + 1);
      }
    }
  }, [
    items,
    id,
    focusedIndex,
    setThreadId,
    setFocusedIndex,
    setMode,
    setActiveReplyId,
    setDraftId,
  ]);

  const handleUnsubscribeProcess = () => {
    if (!emailData?.latest) return;
    toast.promise(handleUnsubscribe({ emailData: emailData.latest }), {
      success: 'Unsubscribed successfully!',
      error: 'Failed to unsubscribe',
    });
  };

  const isInArchive = folder === FOLDERS.ARCHIVE;
  const isInSpam = folder === FOLDERS.SPAM;
  const isInBin = folder === FOLDERS.BIN;
  const handleClose = useCallback(() => {
    setThreadId(null);
    setMode(null);
    setActiveReplyId(null);
    setDraftId(null);
  }, [setThreadId, setMode, setActiveReplyId, setDraftId]);

  const { optimisticMoveThreadsTo } = useOptimisticActions();

  const moveThreadTo = useCallback(
    async (destination: ThreadDestination) => {
      if (!id) return;

      setMode(null);
      setActiveReplyId(null);
      setDraftId(null);

      optimisticMoveThreadsTo([id], folder, destination);
      handleNext();
    },
    [id, folder, optimisticMoveThreadsTo, handleNext, setMode, setActiveReplyId, setDraftId],
  );

  const { optimisticToggleStar } = useOptimisticActions();

  const handleToggleStar = useCallback(async () => {
    if (!emailData || !id) return;

    const newStarredState = !isStarred;
    optimisticToggleStar([id], newStarredState);
    setIsStarred(newStarredState);
  }, [emailData, id, isStarred, optimisticToggleStar]);

  const printThread = () => {
    try {
      // Create a hidden iframe for printing
      const printFrame = document.createElement('iframe');
      printFrame.style.position = 'absolute';
      printFrame.style.top = '-9999px';
      printFrame.style.left = '-9999px';
      printFrame.style.width = '0px';
      printFrame.style.height = '0px';
      printFrame.style.border = 'none';

      document.body.appendChild(printFrame);

      // Generate clean, simple HTML content for printing
      const printContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Print Thread - ${emailData?.latest?.subject || 'No Subject'}</title>
          <style>
            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }

            body {
              font-family: Arial, sans-serif;
              line-height: 1.5;
              color: #333;
              background: white;
              padding: 20px;
              font-size: 12px;
            }

            .email-container {
              max-width: 100%;
              margin: 0 auto;
              background: white;
            }

            .email-header {
              margin-bottom: 25px;
            }

            .email-title {
              font-size: 18px;
              font-weight: bold;
              color: #000;
              margin-bottom: 15px;
              word-wrap: break-word;
            }

            .email-meta {
              margin-bottom: 20px;
            }

            .meta-row {
              margin-bottom: 5px;
              display: flex;
              align-items: flex-start;
            }

            .meta-label {
              font-weight: bold;
              min-width: 60px;
              color: #333;
              margin-right: 10px;
            }

            .meta-value {
              flex: 1;
              word-wrap: break-word;
              color: #333;
            }

            .separator {
              width: 100%;
              height: 1px;
              background: #ddd;
              margin: 20px 0;
            }

            .email-body {
              margin: 20px 0;
              background: white;
            }

            .email-content {
              word-wrap: break-word;
              overflow-wrap: break-word;
              font-size: 12px;
              line-height: 1.6;
            }

            .email-content img {
              max-width: 100% !important;
              height: auto !important;
              display: block;
              margin: 10px 0;
            }

            .email-content table {
              width: 100%;
              border-collapse: collapse;
              margin: 10px 0;
            }

            .email-content td, .email-content th {
              padding: 6px;
              text-align: left;
              font-size: 11px;
            }

            .email-content a {
              color: #0066cc;
              text-decoration: underline;
            }

            .attachments-section {
              margin-top: 25px;
              background: white;
            }

            .attachments-title {
              font-size: 14px;
              font-weight: bold;
              color: #000;
              margin-bottom: 10px;
            }

            .attachment-item {
              margin-bottom: 5px;
              font-size: 11px;
              padding: 3px 0;
            }

            .attachment-name {
              font-weight: 500;
              color: #333;
            }

            .attachment-size {
              color: #666;
              font-size: 10px;
            }

            .labels-section {
              margin: 10px 0;
            }

            .label-badge {
              display: inline-block;
              padding: 2px 6px;
              background: #f5f5f5;
              color: #333;
              font-size: 10px;
              margin-right: 5px;
              margin-bottom: 3px;
            }

            @media print {
              body {
                margin: 0;
                padding: 15px;
                font-size: 11px;
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
              }

              .email-container {
                max-width: none;
                width: 100%;
              }

              .separator {
                background: #000 !important;
              }

              .email-content a {
                color: #000 !important;
              }

              .label-badge {
                background: #f0f0f0 !important;
                border: 1px solid #ccc;
              }

              .no-print {
                display: none !important;
              }

              * {
                border: none !important;
                box-shadow: none !important;
              }

              .email-header {
                page-break-after: avoid;
              }

              .attachments-section {
                page-break-inside: avoid;
              }
            }

            @page {
              margin: 0.5in;
              size: A4;
            }
          </style>
        </head>
        <body>
          ${emailData?.messages
            ?.map(
              (message, index) => `
            <div class="email-container">
              <div class="email-header">
                ${index === 0 ? `<h1 class="email-title">${message.subject || 'No Subject'}</h1>` : ''}


                ${
                  message?.tags && message.tags.length > 0
                    ? `
                  <div class="labels-section">
                    ${message.tags
                      .map((tag) => `<span class="label-badge">${tag.name}</span>`)
                      .join('')}
                  </div>
                `
                    : ''
                }


                <div class="email-meta">
                  <div class="meta-row">
                    <span class="meta-label">From:</span>
                    <span class="meta-value">
                      ${cleanNameDisplay(message.sender?.name)}
                      ${message.sender?.email ? `<${message.sender.email}>` : ''}
                    </span>
                  </div>


                  ${
                    message.to && message.to.length > 0
                      ? `
                    <div class="meta-row">
                      <span class="meta-label">To:</span>
                      <span class="meta-value">
                        ${message.to
                          .map(
                            (recipient) =>
                              `${cleanNameDisplay(recipient.name)} <${recipient.email}>`,
                          )
                          .join(', ')}
                      </span>
                    </div>
                  `
                      : ''
                  }


                  ${
                    message.cc && message.cc.length > 0
                      ? `
                    <div class="meta-row">
                      <span class="meta-label">CC:</span>
                      <span class="meta-value">
                        ${message.cc
                          .map(
                            (recipient) =>
                              `${cleanNameDisplay(recipient.name)} <${recipient.email}>`,
                          )
                          .join(', ')}
                      </span>
                    </div>
                  `
                      : ''
                  }


                  ${
                    message.bcc && message.bcc.length > 0
                      ? `
                    <div class="meta-row">
                      <span class="meta-label">BCC:</span>
                      <span class="meta-value">
                        ${message.bcc
                          .map(
                            (recipient) =>
                              `${cleanNameDisplay(recipient.name)} <${recipient.email}>`,
                          )
                          .join(', ')}
                      </span>
                    </div>
                  `
                      : ''
                  }


                  <div class="meta-row">
                    <span class="meta-label">Date:</span>
                    <span class="meta-value">${format(new Date(message.receivedOn), 'PPpp')}</span>
                  </div>
                </div>
              </div>

              <div class="separator"></div>

              <div class="email-body">
                <div class="email-content">
                  ${cleanHtml(message.decodedBody ?? '<p><em>No email content available</em></p>')}
                </div>
              </div>


              ${
                message.attachments && message.attachments.length > 0
                  ? `
                <div class="attachments-section">
                  <h2 class="attachments-title">Attachments (${message.attachments.length})</h2>
                  ${message.attachments
                    .map(
                      (attachment) => `
                    <div class="attachment-item">
                      <span class="attachment-name">${attachment.filename}</span>
                      ${formatFileSize(attachment.size) ? ` - <span class="attachment-size">${formatFileSize(attachment.size)}</span>` : ''}
                    </div>
                  `,
                    )
                    .join('')}
                </div>
              `
                  : ''
              }
            </div>
            ${index < emailData.messages.length - 1 ? '<div class="separator"></div>' : ''}
          `,
            )
            .join('')}
        </body>
      </html>
    `;

      // Write content to the iframe
      const iframeDoc = printFrame.contentDocument || printFrame.contentWindow?.document;
      if (!iframeDoc) {
        throw new Error('Could not access iframe document');
      }
      iframeDoc.open();
      iframeDoc.write(printContent);
      iframeDoc.close();

      // Wait for content to load, then print
      printFrame.onload = function () {
        setTimeout(() => {
          try {
            // Focus the iframe and print
            printFrame.contentWindow?.focus();
            printFrame.contentWindow?.print();

            // Clean up - remove the iframe after a delay
            setTimeout(() => {
              if (printFrame && printFrame.parentNode) {
                document.body.removeChild(printFrame);
              }
            }, 1000);
          } catch (error) {
            console.error('Error during print:', error);
            // Clean up on error
            if (printFrame && printFrame.parentNode) {
              document.body.removeChild(printFrame);
            }
          }
        }, 500);
      };
    } catch (error) {
      console.error('Error printing thread:', error);
      toast.error('Failed to print thread. Please try again.');
    }
  };

  // Set initial star state based on email data
  useEffect(() => {
    if (emailData?.latest?.tags) {
      // Check if any tag has the name 'STARRED'
      setIsStarred(emailData.latest.tags.some((tag) => tag.name === 'STARRED'));
    }
  }, [emailData?.latest?.tags]);

  useEffect(() => {
    if (optimisticState.optimisticStarred !== null) {
      setIsStarred(optimisticState.optimisticStarred);
    }
  }, [optimisticState.optimisticStarred]);

  //   // Automatically open Reply All composer when email thread is loaded
  //   useEffect(() => {
  //     if (emailData?.latest?.id) {
  //       // Small delay to ensure other effects have completed
  //       const timer = setTimeout(() => {
  //         setMode('replyAll');
  //         setActiveReplyId(emailData.latest!.id);
  //       }, 50);

  //       return () => clearTimeout(timer);
  //     }
  //   }, [emailData?.latest?.id, setMode, setActiveReplyId]);

  // Removed conflicting useEffect that was clearing activeReplyId

  // Scroll to the active reply composer when it's opened
  useEffect(() => {
    if (mode && activeReplyId) {
      setTimeout(() => {
        const replyElement = document.getElementById(`reply-composer-${activeReplyId}`);
        if (replyElement) {
          replyElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 100); // Short delay to ensure the component is rendered
    }
  }, [mode, activeReplyId]);

  return (
    <div
      className={cn(
        'flex flex-col',
        isFullscreen ? 'h-screen' : isMobile ? 'h-full' : 'h-[calc(100dvh-19px)] rounded-xl',
      )}
    >
      <div
        className={cn(
          'bg-ax-surface relative flex flex-col overflow-hidden rounded-xl',
          isMobile ? 'h-full' : 'h-full',
          !isMobile && !isFullscreen && 'rounded-r-lg',
          isFullscreen ? 'fixed inset-0 z-50' : '',
        )}
      >
        {!id ? (
          <div className="flex h-full items-center justify-center">
            <div className="ax-empty-enter flex flex-col items-center justify-center gap-2 text-center">
              <EmptyStateIcon width={200} height={200} />
              <div className="mt-4">
                <p className="ax-type-body font-[var(--ax-weight-medium)] text-ax-primary">It's empty here</p>
                <p className="ax-type-ui mt-1 text-ax-tertiary">
                  Choose an email to view details
                </p>
                <div className="mt-4 grid grid-cols-1 gap-2 xl:grid-cols-2">
                  <button
                    onClick={toggleAISidebar}
                    className="ax-pressable ax-type-ui inline-flex h-7 cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-ax-control border border-ax-border bg-ax-raised px-1.5 text-ax-primary transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring px-2"
                  >
                    <Sparkles className="mr-1 h-3.5 w-3.5 fill-ax-tertiary" />
                    <div className="flex items-center justify-center gap-2.5 px-0.5">
                      <div className="justify-start leading-none">
                        AxMail chat
                      </div>
                    </div>
                  </button>
                  <button
                    onClick={() => setIsComposeOpen('true')}
                    className="ax-pressable ax-type-ui inline-flex h-7 cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-ax-control border border-ax-border bg-ax-raised px-1.5 text-ax-primary transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring px-2"
                  >
                    <Mail className="mr-1 h-3.5 w-3.5 fill-ax-tertiary" />
                    <div className="flex items-center justify-center gap-2.5 px-0.5">
                      <div className="justify-start leading-none">
                        Send email
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : !emailData || isLoading ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ScrollArea className="h-full flex-1" type="auto">
              <div className="pb-4">
                <MailDisplaySkeleton isFullscreen={isFullscreen} />
              </div>
            </ScrollArea>
          </div>
        ) : (
          <>
            <div
              className={cn(
                'flex shrink-0 items-center px-1 pb-[10px] md:px-3 md:pb-[11px] md:pt-[12px]',
                isMobile && 'bg-ax-surface sticky top-0 z-10 mt-2',
              )}
            >
              <div className="flex flex-1 items-center gap-2">
                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={handleClose}
                        className="ax-pressable inline-flex h-7 w-7 items-center justify-center gap-1 overflow-hidden rounded-ax-control text-ax-secondary hover:bg-ax-hover md:hidden"
                      >
                        <X className="fill-ax-secondary h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="bg-ax-overlay">
                      {m['common.actions.close']()}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <ThreadActionButton
                  icon={X}
                  label={m['common.actions.close']()}
                  onClick={handleClose}
                  className="hidden md:flex"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMode('replyAll');
                    setActiveReplyId(emailData?.latest?.id ?? '');
                  }}
                  className="ax-pressable ax-type-ui inline-flex h-7 cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-ax-control border border-ax-border bg-ax-raised px-1.5 text-ax-primary transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring"
                >
                  <Reply className="fill-ax-secondary" />
                  <div className="flex items-center justify-center gap-2.5 pl-0.5 pr-1">
                    <div className="justify-start whitespace-nowrap leading-none">
                      {m['common.threadDisplay.replyAll']()}
                    </div>
                  </div>
                </button>
                <NotesPanel threadId={id} />
                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={handleToggleStar}
                        className="ax-pressable inline-flex h-7 w-7 cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-ax-control bg-ax-raised text-ax-secondary transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-overlay hover:text-ax-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring"
                      >
                        <Star
                          className={cn(
                            'ml-[2px] mt-[2.4px] h-5 w-5',
                            isStarred
                              ? 'fill-ax-warning stroke-ax-warning'
                              : 'fill-transparent stroke-ax-tertiary',
                          )}
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="bg-ax-overlay">
                      {isStarred
                        ? m['common.threadDisplay.unstar']()
                        : m['common.threadDisplay.star']()}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => moveThreadTo('archive')}
                        className="ax-pressable inline-flex h-7 w-7 cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-ax-control bg-ax-raised text-ax-secondary transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-overlay hover:text-ax-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring"
                      >
                        <Archive className="fill-iconLight dark:fill-iconDark" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="bg-ax-overlay">
                      {m['common.threadDisplay.archive']()}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                {!isInBin && (
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => moveThreadTo('bin')}
                          className="ax-pressable inline-flex h-7 w-7 cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-ax-control bg-ax-danger-muted transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-danger/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring"
                        >
                          <Trash className="fill-ax-danger" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="bg-ax-overlay">
                        {m['common.mail.moveToBin']()}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label="Thread actions" aria-haspopup="menu" className="ax-pressable inline-flex h-7 w-7 cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-ax-control bg-ax-raised text-ax-secondary transition-colors duration-[var(--ax-dur-fast)] hover:bg-ax-overlay hover:text-ax-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring">
                      <ThreeDots className="fill-iconLight dark:fill-iconDark" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="ax-type-ui border-ax-border bg-ax-overlay text-ax-primary shadow-ax-popover">
                    {/* <DropdownMenuItem onClick={() => setIsFullscreen(!isFullscreen)}>
                      <Expand className="fill-ax-secondary mr-2" />
                      <span>
                        {isFullscreen
                          ? t('common.threadDisplay.exitFullscreen')
                          : t('common.threadDisplay.enterFullscreen')}
                      </span>
                    </DropdownMenuItem> */}

                    {isInSpam || isInArchive || isInBin ? (
                      <DropdownMenuItem onClick={() => moveThreadTo('inbox')}>
                        <Inbox className="mr-2 h-4 w-4" />
                        <span>{m['common.mail.moveToInbox']()}</span>
                      </DropdownMenuItem>
                    ) : (
                      <>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            printThread();
                          }}
                        >
                          <Printer className="fill-ax-secondary mr-2 h-4 w-4" />
                          <span>{m['common.threadDisplay.printThread']()}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => moveThreadTo('spam')}>
                          <ArchiveX className="fill-ax-secondary mr-2" />
                          <span>{m['common.threadDisplay.moveToSpam']()}</span>
                        </DropdownMenuItem>
                        {emailData.latest?.listUnsubscribe ||
                        emailData.latest?.listUnsubscribePost ? (
                          <DropdownMenuItem onClick={handleUnsubscribeProcess}>
                            <Folders className="fill-ax-secondary mr-2" />
                            <span>{m['common.mailDisplay.unsubscribe']()}</span>
                          </DropdownMenuItem>
                        ) : null}
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <div className={cn('flex min-h-0 flex-1 flex-col', isMobile && 'h-full')}>
              {/* Thread navigation renders INSTANTLY. The 25px slide that
                  lived here animated a keyboard-driven action (j/k), and
                  AnimatePresence mode="wait" serialized exit before enter —
                  fast navigation waited on animation. Per the approved
                  motion plan: keyboard actions never animate. */}
              <MessageList
                messages={emailData.messages}
                isFullscreen={isFullscreen}
                totalReplies={emailData?.totalReplies}
                allThreadAttachments={allThreadAttachments}
                mode={mode || undefined}
                activeReplyId={activeReplyId || undefined}
                isMobile={isMobile}
              />

              {mode &&
                activeReplyId &&
                activeReplyId === emailData.messages[emailData.messages.length - 1]?.id && (
                  <div
                    className="border-ax-border-subtle bg-ax-surface sticky bottom-0 z-10 border-t px-4 py-2"
                    id={`reply-composer-${activeReplyId}`}
                  >
                    <ReplyCompose messageId={activeReplyId} />
                  </div>
                )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface MessageListProps {
  messages: ParsedMessage[];
  isFullscreen: boolean;
  totalReplies?: number;
  allThreadAttachments?: Attachment[];
  mode?: string;
  activeReplyId?: string;
  isMobile: boolean;
}

const MessageList = ({
  messages,
  isFullscreen,
  totalReplies,
  allThreadAttachments,
  mode,
  activeReplyId,
  isMobile,
}: MessageListProps) => (
  <ScrollArea className={cn('flex-1', isMobile ? 'h-[calc(100%-1px)]' : 'h-full')} type="auto">
    <div className="pb-4">
      {(messages || []).map((message, index) => {
        const isLastMessage = index === messages.length - 1;
        const isReplyingToThisMessage = mode && activeReplyId === message.id;

        return (
          <div
            key={message.id}
            className={cn('duration-200', index > 0 && 'border-ax-border-subtle border-t')}
          >
            <MailDisplay
              emailData={message}
              isFullscreen={isFullscreen}
              isLoading={false}
              index={index}
              totalEmails={totalReplies}
              threadAttachments={index === 0 ? allThreadAttachments : undefined}
            />
            {isReplyingToThisMessage && !isLastMessage && (
              <div className="px-4 py-2" id={`reply-composer-${message.id}`}>
                <ReplyCompose messageId={message.id} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  </ScrollArea>
);
