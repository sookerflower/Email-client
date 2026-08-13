import {
  Archive2,
  GroupPeople,
  Star2,
  Trash,
  PencilCompose,
} from '../icons/icons';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  useState,
} from 'react';
import { useOptimisticThreadState } from '@/components/mail/optimistic-thread-state';
import { focusedIndexAtom, useMailNavigation } from '@/hooks/use-mail-navigation';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsFetching, type UseQueryResult } from '@tanstack/react-query';
import type { MailSelectMode, ParsedMessage, ThreadProps } from '@/types';
import type { ParsedDraft } from '../../../server/src/lib/driver/types';
import { ThreadContextMenu } from '@/components/context/thread-context';
import { useOptimisticActions } from '@/hooks/use-optimistic-actions';
import { useMail, type Config } from '@/components/mail/use-mail';
import { type ThreadDestination } from '@/lib/thread-actions';
import { useThread, useThreads } from '@/hooks/use-threads';
import { useSearchValue } from '@/hooks/use-search-value';
import { EmptyStateIcon } from '../icons/empty-state-svg';
import { highlightText } from '@/lib/email-utils.client';
import { cn, FOLDERS, formatDate } from '@/lib/utils';
import { useTRPC } from '@/providers/query-provider';
import { useThreadLabels } from '@/hooks/use-labels';
import { useSettings } from '@/hooks/use-settings';
import { useKeyState } from '@/hooks/use-hot-key';
import { VList, type VListHandle } from 'virtua';
import { BimiAvatar } from '../ui/bimi-avatar';
import { RenderLabels } from './render-labels';
import { Badge } from '@/components/ui/badge';
import { useDraft } from '@/hooks/use-drafts';
import { Check, Star } from 'lucide-react';
import { Skeleton } from '../ui/skeleton';
import { m } from '@/paraglide/messages';
import { useParams } from 'react-router';
import { Button } from '../ui/button';
import { Avatar } from '../ui/avatar';
import { useQueryState } from 'nuqs';
import { useAtom } from 'jotai';

const Thread = memo(
  function Thread({
    message,
    onClick,
    isKeyboardFocused,
    index,
  }: ThreadProps & { index?: number }) {
    const [searchValue] = useSearchValue();
    const { folder } = useParams<{ folder: string }>();
    const [, threads] = useThreads();
    const [threadId] = useQueryState('threadId');
    const { data: getThreadData, isGroupThread, latestDraft } = useThread(message.id);
    const [id, setThreadId] = useQueryState('threadId');
    const [focusedIndex, setFocusedIndex] = useAtom(focusedIndexAtom);

    const { latestMessage, idToUse, cleanName } = useMemo(() => {
      const latestMessage = getThreadData?.latest;
      const idToUse = latestMessage?.threadId ?? latestMessage?.id;
      const cleanName = latestMessage?.sender?.name
        ? latestMessage.sender.name.trim().replace(/^['"]|['"]$/g, '')
        : '';

      return { latestMessage, idToUse, cleanName };
    }, [getThreadData?.latest]);

    const optimisticState = useOptimisticThreadState(idToUse ?? '');

    const { displayStarred, displayUnread, optimisticLabels, emailContent } =
      useMemo(() => {
        const emailContent = getThreadData?.latest?.body;
        const displayStarred =
          optimisticState.optimisticStarred !== null
            ? optimisticState.optimisticStarred
            : (getThreadData?.latest?.tags?.some((tag) => tag.name === 'STARRED') ?? false);

        const displayUnread =
          optimisticState.optimisticRead !== null
            ? !optimisticState.optimisticRead
            : (getThreadData?.hasUnread ?? false);

        let labels: { id: string; name: string }[] = [];
        if (getThreadData?.labels) {
          labels = [...getThreadData.labels];
          const hasStarredLabel = labels.some((label) => label.name === 'STARRED');

          if (optimisticState.optimisticStarred !== null) {
            if (optimisticState.optimisticStarred && !hasStarredLabel) {
              labels.push({ id: 'starred-optimistic', name: 'STARRED' });
            } else if (!optimisticState.optimisticStarred && hasStarredLabel) {
              labels = labels.filter((label) => label.name !== 'STARRED');
            }
          }

          if (optimisticState.optimisticLabels) {
            labels = labels.filter(
              (label) => !optimisticState.optimisticLabels.removedLabelIds.includes(label.id),
            );

            optimisticState.optimisticLabels.addedLabelIds.forEach((labelId) => {
              if (!labels.some((label) => label.id === labelId)) {
                labels.push({ id: labelId, name: labelId });
              }
            });
          }
        }

        return {
          displayStarred,
          displayUnread,
          optimisticLabels: labels,
          emailContent,
        };
      }, [
        optimisticState.optimisticStarred,
        optimisticState.optimisticRead,
        getThreadData?.latest?.tags,
        getThreadData?.hasUnread,
        getThreadData?.labels,
        optimisticState.optimisticLabels,
      ]);

    const { optimisticToggleStar, optimisticMoveThreadsTo } =
      useOptimisticActions();

    const handleToggleStar = useCallback(
      async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!getThreadData || !idToUse) return;

        const newStarredState = !displayStarred;
        optimisticToggleStar([idToUse], newStarredState);
      },
      [getThreadData, idToUse, displayStarred, optimisticToggleStar],
    );


    const handleNext = useCallback(
      (id: string) => {
        if (!id || !threads.length || focusedIndex === null) return setThreadId(null);
        if (focusedIndex < threads.length - 1) {
          const nextThread = threads[focusedIndex];
          if (nextThread) {
            setThreadId(nextThread.id);
            // Don't clear activeReplyId - let ThreadDisplay handle Reply All auto-opening
            setFocusedIndex(focusedIndex);
          }
        }
      },
      [threads, id, focusedIndex],
    );

    const moveThreadTo = useCallback(
      async (destination: ThreadDestination) => {
        if (!idToUse) return;
        handleNext(idToUse);
        optimisticMoveThreadsTo([idToUse], folder ?? '', destination);
      },
      [idToUse, folder, optimisticMoveThreadsTo, handleNext],
    );

    const { labels: threadLabels } = useThreadLabels(
      optimisticLabels ? optimisticLabels.map((l) => l.id) : [],
    );

    const [mailState, setMail] = useMail();
    const { isMailSelected, isMailBulkSelected } = useMemo(() => {
      const isSelected =
        !threadId || !idToUse ? false : idToUse === threadId || threadId === mailState.selected;
      const isBulkSelected = idToUse ? mailState.bulkSelected.includes(idToUse) : false;

      return { isMailSelected: isSelected, isMailBulkSelected: isBulkSelected };
    }, [threadId, idToUse, mailState.selected, mailState.bulkSelected]);

    const { isFolderInbox, isFolderSpam, isFolderSent, isFolderBin } = useMemo(
      () => ({
        isFolderInbox: folder === FOLDERS.INBOX || !folder,
        isFolderSpam: folder === FOLDERS.SPAM,
        isFolderSent: folder === FOLDERS.SENT,
        isFolderBin: folder === FOLDERS.BIN,
      }),
      [folder],
    );

    // Check if thread has a draft
    const hasDraft = useMemo(() => {
      return !!latestDraft;
    }, [latestDraft]);

    const content = useMemo(() => {
      if (!latestMessage || !getThreadData) return null;

      return (
        <div
          className={cn('select-none border-b border-ax-border-subtle md:my-0.5 md:border-none')}
          onClick={onClick ? onClick(latestMessage) : undefined}
        >
          {/* 36px single-line row (approved density). Hot-path rule: no
              enter/exit/reorder motion, no hover scale — state changes are
              instant color swaps on tokens. */}
          <div
            data-thread-id={idToUse}
            key={idToUse}
            className={cn(
              'group relative mx-1 flex min-h-[var(--ax-row-h)] cursor-pointer items-center gap-2.5 rounded-ax-control px-3 text-left hover:bg-ax-hover',
              (isMailSelected || isMailBulkSelected) && 'bg-ax-selected hover:bg-ax-selected',
              isKeyboardFocused && 'ring-1 ring-inset ring-ax-ring',
            )}
          >
            <div
              className={cn(
                'z-25 absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-ax-control border border-ax-border bg-ax-overlay p-0.5 opacity-0 shadow-ax-raised group-hover:opacity-100',
              )}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 overflow-visible [&_svg]:size-3.5"
                    onClick={handleToggleStar}
                  >
                    <Star2
                      className={cn(
                        'h-4 w-4',
                        displayStarred
                          ? 'fill-ax-warning stroke-ax-warning'
                          : 'fill-transparent stroke-ax-tertiary',
                      )}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  side={index === 0 ? 'bottom' : 'top'}
                  className="mb-1 bg-ax-overlay"
                >
                  {displayStarred
                    ? m['common.threadDisplay.unstar']()
                    : m['common.threadDisplay.star']()}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 [&_svg]:size-3.5"
                    onClick={(e) => {
                      e.stopPropagation();
                      moveThreadTo('archive');
                    }}
                  >
                    <Archive2 className="fill-ax-tertiary" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  side={index === 0 ? 'bottom' : 'top'}
                  className="mb-1 bg-ax-overlay"
                >
                  {m['common.threadDisplay.archive']()}
                </TooltipContent>
              </Tooltip>
              {!isFolderBin ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 hover:bg-ax-danger-muted [&_svg]:size-3.5"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        moveThreadTo('bin');
                      }}
                    >
                      <Trash className="fill-ax-danger" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side={index === 0 ? 'bottom' : 'top'}
                    className="mb-1 bg-ax-overlay"
                  >
                    {m['common.actions.Bin']()}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>

            {/* Avatar doubles as the bulk-select toggle — all three variants
                and the deselect click handler are unchanged, just 24px. */}
            <div className="shrink-0">
              {isMailBulkSelected ? (
                <Avatar className={cn('h-6 w-6 rounded-full')}>
                  <div
                    className="flex h-full w-full items-center justify-center rounded-full bg-ax-accent p-1"
                    onClick={(e: React.MouseEvent) => {
                      e.stopPropagation();
                      setMail((prev: Config) => ({
                        ...prev,
                        bulkSelected: prev.bulkSelected.filter((id: string) => id !== idToUse),
                      }));
                    }}
                  >
                    <Check className="h-3.5 w-3.5 text-ax-on-accent" />
                  </div>
                </Avatar>
              ) : isGroupThread ? (
                <Avatar className={cn('h-6 w-6 rounded-full border border-ax-border')}>
                  <div className="flex h-full w-full items-center justify-center rounded-full bg-ax-raised p-1">
                    <GroupPeople className="h-3.5 w-3.5" />
                  </div>
                </Avatar>
              ) : (
                <BimiAvatar
                  email={latestMessage.sender.email}
                  name={cleanName || latestMessage.sender.email}
                  className={cn('h-6 w-6 rounded-full border border-ax-border')}
                />
              )}
            </div>

            {/* Unread dot — reserved width so read/unread rows align. */}
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                displayUnread && !isMailSelected && !isFolderSent ? 'bg-ax-accent' : 'bg-transparent',
              )}
            />

            {/* Sender (subject in Sent) + reply count + draft marker. */}
            <span
              className={cn(
                'ax-type-ui flex w-28 shrink-0 items-center gap-1 xl:w-40',
                displayUnread && !isMailSelected
                  ? 'font-[var(--ax-weight-semibold)] text-ax-primary'
                  : 'text-ax-secondary',
              )}
            >
              <span className="min-w-0 truncate">
                {isFolderSent
                  ? highlightText(latestMessage.subject, searchValue.highlight)
                  : highlightText(
                      cleanNameDisplay(latestMessage.sender.name) ||
                        latestMessage.sender.email ||
                        '',
                      searchValue.highlight,
                    )}
              </span>
              {getThreadData.totalReplies > 1 ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="ax-type-small shrink-0 tabular-nums text-ax-tertiary">
                      [{getThreadData.totalReplies}]
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="p-1 text-xs">
                    {m['common.mail.replies']({ count: getThreadData.totalReplies })}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {hasDraft ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex shrink-0 items-center">
                      <PencilCompose className="h-3 w-3 fill-ax-accent" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="p-1 text-xs">Draft</TooltipContent>
                </Tooltip>
              ) : null}
              <MailLabels labels={optimisticLabels} />
            </span>

            {/* Subject (recipients in Sent), with the search snippet inline. */}
            <span
              className={cn(
                'ax-type-ui min-w-0 flex-1 truncate',
                displayUnread && !isMailSelected ? 'text-ax-primary' : 'text-ax-tertiary',
              )}
            >
              {isFolderSent
                ? latestMessage.to.map((e) => e.email).join(', ')
                : highlightText(latestMessage.subject, searchValue.highlight)}
              {emailContent ? (
                <span className="text-ax-tertiary">
                  {' — '}
                  {highlightText(emailContent, searchValue.highlight)}
                </span>
              ) : null}
            </span>

            {threadLabels && !isFolderSent ? (
              <div className="flex w-fit shrink-0 items-center justify-end gap-1">
                <RenderLabels labels={threadLabels} />
              </div>
            ) : null}

            {latestMessage.receivedOn ? (
              <p className="ax-type-small shrink-0 text-nowrap tabular-nums text-ax-tertiary">
                {formatDate(latestMessage.receivedOn.split('.')[0] || '')}
              </p>
            ) : null}
          </div>
        </div>
      );
    }, [
      latestMessage,
      getThreadData,
      optimisticState,
      idToUse,
      folder,
      isFolderBin,
      isFolderSent,
      isFolderSpam,
      isFolderInbox,
      onClick,
      searchValue,
      displayUnread,
      isMailSelected,
      isMailBulkSelected,
      threadLabels,
      optimisticLabels,
      emailContent,
    ]);

    return latestMessage ? (
      !optimisticState.shouldHide && idToUse ? (
        <ThreadContextMenu
          threadId={idToUse}
          isInbox={isFolderInbox}
          isSpam={isFolderSpam}
          isSent={isFolderSent}
          isBin={isFolderBin}
        >
          {content}
        </ThreadContextMenu>
      ) : null
    ) : null;
  },
  (prev, next) => {
    const isSameMessage =
      prev.message.id === next.message.id &&
      prev.isKeyboardFocused === next.isKeyboardFocused &&
      prev.index === next.index &&
      Object.is(prev.onClick, next.onClick);
    return isSameMessage;
  },
);

const Draft = memo(({ message, index }: { message: { id: string }; index: number }) => {
  const draftQuery = useDraft(message.id) as UseQueryResult<ParsedDraft>;
  const draft = draftQuery.data;
  const [, setComposeOpen] = useQueryState('isComposeOpen');
  const [, setDraftId] = useQueryState('draftId');
  const { optimisticDeleteDraft } = useOptimisticActions();
  const optimisticState = useOptimisticThreadState(message.id);

  const handleMailClick = useCallback(() => {
    setComposeOpen('true');
    setDraftId(message.id);
    return;
  }, [message.id]);

  const handleDeleteDraft = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      optimisticDeleteDraft(message.id);
    },
    [message.id, optimisticDeleteDraft],
  );

  if (optimisticState.shouldHide) {
    return null;
  }

  if (!draft) {
    return (
      <div className="select-none">
        <div
          key={message.id}
          className={cn(
            'mx-1 flex min-h-[var(--ax-row-h)] cursor-pointer items-center gap-2.5 rounded-ax-control px-3',
          )}
        >
          <Skeleton className="bg-ax-raised h-3.5 w-32 rounded" />
          <Skeleton className="bg-ax-raised h-3.5 w-48 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="select-none" onClick={handleMailClick}>
      <div
        key={message.id}
        className={cn(
          'group relative mx-1 flex min-h-[var(--ax-row-h)] cursor-pointer items-center gap-2.5 rounded-ax-control px-3 text-left hover:bg-ax-hover',
        )}
      >
        <div
          className={cn(
            'absolute right-2 top-1/2 z-20 flex -translate-y-1/2 items-center gap-0.5 rounded-ax-control border border-ax-border bg-ax-overlay p-0.5 opacity-0 shadow-ax-raised group-hover:opacity-100',
          )}
          aria-busy={optimisticState.isRemoving}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 hover:bg-ax-danger-muted [&_svg]:size-3.5"
                aria-label="Delete draft"
                disabled={optimisticState.isRemoving}
                onClick={handleDeleteDraft}
              >
                <Trash className="fill-ax-danger" />
              </Button>
            </TooltipTrigger>
            <TooltipContent
              side={index === 0 ? 'bottom' : 'top'}
              className="mb-1 bg-ax-overlay"
            >
              {m['common.actions.Bin']()}
            </TooltipContent>
          </Tooltip>
        </div>
        <span className="ax-type-ui w-28 shrink-0 truncate font-[var(--ax-weight-medium)] text-ax-secondary xl:w-40">
          {cleanNameDisplay(draft?.to?.[0] || 'No Recipient') || ''}
        </span>
        <span className="ax-type-ui min-w-0 flex-1 truncate text-ax-tertiary">
          {draft?.subject}
        </span>
        {draft.rawMessage?.internalDate && (
          <p className="ax-type-small shrink-0 text-nowrap tabular-nums text-ax-tertiary">
            {formatDate(Number(draft.rawMessage?.internalDate))}
          </p>
        )}
      </div>
    </div>
  );
});

Draft.displayName = 'Draft';

export const MailList = memo(
  function MailList() {
    const { folder } = useParams<{ folder: string }>();
    const { data: settingsData } = useSettings();
    const [, setThreadId] = useQueryState('threadId');
    const [, setDraftId] = useQueryState('draftId');
    const [searchValue, setSearchValue] = useSearchValue();
    const [anchorIndex, setAnchorIndex] = useState<number | null>(null);

    useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setAnchorIndex(null);
        }
      };

      window.addEventListener('keydown', handleKeyDown);

      return () => {
        window.removeEventListener('keydown', handleKeyDown);
      };
    }, [setAnchorIndex]);

    const [{ refetch, isLoading, isFetching, isFetchingNextPage, hasNextPage }, items, , loadMore] =
      useThreads();
    const trpc = useTRPC();
    const isFetchingMail = useIsFetching({ queryKey: trpc.mail.get.queryKey() }) > 0;
    const itemsRef = useRef(items);
    const parentRef = useRef<HTMLDivElement>(null);
    const vListRef = useRef<VListHandle>(null);

    useEffect(() => {
      itemsRef.current = items;
    }, [items]);

    // Add event listener for refresh
    useEffect(() => {
      const handleRefresh = () => {
        void refetch();
      };

      window.addEventListener('refreshMailList', handleRefresh);
      return () => window.removeEventListener('refreshMailList', handleRefresh);
    }, [refetch]);

    const handleNavigateToThread = useCallback(
      (threadId: string | null) => {
        setThreadId(threadId);
        return;
      },
      [setThreadId],
    );

    const { focusedIndex, handleMouseEnter, keyboardActive } = useMailNavigation({
      items,
      containerRef: parentRef,
      onNavigate: handleNavigateToThread,
    });

    const isKeyPressed = useKeyState();

    const getSelectMode = useCallback((): MailSelectMode => {
      const isAltPressed =
        isKeyPressed('Alt') || isKeyPressed('AltLeft') || isKeyPressed('AltRight');
      const isShiftPressed =
        isKeyPressed('Shift') || isKeyPressed('ShiftLeft') || isKeyPressed('ShiftRight');
      const isCtrlPressed = isKeyPressed('Control') || isKeyPressed('Meta');

      if (isShiftPressed && !isCtrlPressed) {
        return 'range';
      }
      if (isCtrlPressed) {
        return 'mass';
      }
      if (isAltPressed && isShiftPressed) {
        console.log('Select All Below mode activated'); // Debug log
        return 'selectAllBelow';
      }
      return 'single';
    }, [isKeyPressed]);

    const [, setActiveReplyId] = useQueryState('activeReplyId');
    const [, setMail] = useMail();

    const handleSelectMail = useCallback(
      (message: ParsedMessage) => {
        const itemId = message.threadId ?? message.id;
        const currentMode = getSelectMode();
        console.log('Selection mode:', currentMode, 'for item:', itemId);

        setMail((prevMail) => {
          const mail = prevMail;
          const clickedIndex = itemsRef.current.findIndex((item) => item.id === itemId);
          if (clickedIndex === -1) return mail;

          switch (currentMode) {
            case 'mass': {
              const newSelected = mail.bulkSelected.includes(itemId)
                ? mail.bulkSelected.filter((id) => id !== itemId)
                : [...mail.bulkSelected, itemId];
              console.log('Mass selection mode - selected items:', newSelected.length);
              return { ...mail, bulkSelected: newSelected };
            }
            case 'selectAllBelow': {
              const clickedIndex = itemsRef.current.findIndex((item) => item.id === itemId);
              console.log(
                'SelectAllBelow - clicked index:',
                clickedIndex,
                'total items:',
                itemsRef.current.length,
              );

              if (clickedIndex !== -1) {
                const itemsBelow = itemsRef.current.slice(clickedIndex);
                const idsBelow = itemsBelow.map((item) => item.id);
                console.log('Selecting all items below - count:', idsBelow.length);
                return { ...mail, bulkSelected: idsBelow };
              }
              console.log('Item not found in list, selecting just this item');
              return { ...mail, bulkSelected: [itemId] };
            }
            case 'range': {
              console.log('Range selection mode');
              if (anchorIndex === null) {
                return { ...mail, bulkSelected: [itemId] };
              }
              const start = Math.min(anchorIndex, clickedIndex);
              const end = Math.max(anchorIndex, clickedIndex);
              const rangeIds = itemsRef.current.slice(start, end + 1).map((item) => item.id);
              const newSelected = [...new Set([...mail.bulkSelected, ...rangeIds])];

              return { ...mail, bulkSelected: newSelected };
            }
            default: {
              console.log('Single selection mode');
              return { ...mail, bulkSelected: [itemId] };
            }
          }
        });
      },
      [getSelectMode, setMail, anchorIndex],
    );

    const [, setFocusedIndex] = useAtom(focusedIndexAtom);

    const { optimisticMarkAsRead } = useOptimisticActions();
    const handleMailClick = useCallback(
      (message: ParsedMessage) => async () => {
        const mode = getSelectMode();
        const autoRead = settingsData?.settings?.autoRead ?? true;
        console.log('Mail click with mode:', mode);

        if (mode !== 'single') {
          const messageThreadId = message.threadId ?? message.id;
          const clickedIndex = itemsRef.current.findIndex((item) => item.id === messageThreadId);
          if (clickedIndex !== -1 && mode !== 'range') {
            setAnchorIndex(clickedIndex);
          }
          return handleSelectMail(message);
        }

        handleMouseEnter(message.id);

        const messageThreadId = message.threadId ?? message.id;
        const clickedIndex = itemsRef.current.findIndex((item) => item.id === messageThreadId);
        setFocusedIndex(clickedIndex);
        if (message.unread && autoRead) optimisticMarkAsRead([messageThreadId], true);
        setThreadId(messageThreadId);
        setDraftId(null);
        // Don't clear activeReplyId - let ThreadDisplay handle Reply All auto-opening
      },
      [
        getSelectMode,
        handleSelectMail,
        handleMouseEnter,
        setFocusedIndex,
        optimisticMarkAsRead,
        setThreadId,
        setDraftId,
        settingsData,
        setActiveReplyId,
      ],
    );

    const isFiltering = searchValue.value.trim().length > 0;

    useEffect(() => {
      if (isFiltering && !isLoading) {
        setSearchValue({
          ...searchValue,
          isLoading: false,
        });
      }
    }, [isLoading, isFiltering, setSearchValue]);

    const clearFilters = () => {
      setSearchValue({
        value: '',
        highlight: '',
        folder: '',
      });
    };

    const filteredItems = useMemo(() => items.filter((item) => item.id), [items]);

    const Comp = useMemo(() => (folder === FOLDERS.DRAFT ? Draft : Thread), [folder]);

    const vListRenderer = useCallback(
      (index: number) => {
        const item = filteredItems[index];
        return item ? (
          <>
            <Comp
              key={item.id}
              message={item}
              isKeyboardFocused={focusedIndex === index && keyboardActive}
              index={index}
              onClick={handleMailClick}
            />
            {index === filteredItems.length - 1 && (isFetchingNextPage || isFetchingMail) ? (
              <div className="flex w-full justify-center py-4">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-ax-tertiary border-t-transparent" />
              </div>
            ) : null}
          </>
        ) : (
          <></>
        );
      },
      [
        folder,
        filteredItems,
        focusedIndex,
        keyboardActive,
        isFetchingMail,
        isFetchingNextPage,
        handleMailClick,
        isLoading,
        isFetching,
        hasNextPage,
      ],
    );

    return (
      <>
        <div
          ref={parentRef}
          className={cn(
            'hide-link-indicator flex h-full w-full',
            getSelectMode() === 'range' && 'select-none',
          )}
        >
          <>
            {isLoading ? (
              <div className="flex h-32 w-full items-center justify-center">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-ax-tertiary border-t-transparent" />
              </div>
            ) : !items || items.length === 0 ? (
              <div className="flex w-full items-center justify-center">
                {/* The delight slot: one 280ms fade-up on mount, never on the
                    list itself. */}
                <div className="ax-empty-enter flex flex-col items-center justify-center gap-2 text-center">
                  <EmptyStateIcon width={200} height={200} />
                  <div className="mt-5">
                    <p className="ax-type-body font-[var(--ax-weight-medium)] text-ax-primary">
                      It's empty here
                    </p>
                    <p className="ax-type-ui mt-1 text-ax-tertiary">
                      Search for another email or{' '}
                      <button
                        type="button"
                        className="cursor-pointer text-ax-secondary underline underline-offset-2 hover:text-ax-primary"
                        onClick={clearFilters}
                      >
                        clear filters
                      </button>
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col" id="mail-list-scroll">
                <VList
                  ref={vListRef}
                  count={filteredItems.length}
                  overscan={5}
                  itemSize={100}
                  className="scrollbar-none flex-1 overflow-x-hidden"
                  onScroll={() => {
                    if (!vListRef.current) return;
                    const endIndex = vListRef.current.findEndIndex();
                    if (
                      // if the shown items are last 5 items, load more
                      Math.abs(filteredItems.length - 1 - endIndex) < 7 &&
                      !isLoading &&
                      !isFetchingNextPage &&
                      !isFetchingMail &&
                      hasNextPage
                    ) {
                      void loadMore();
                    }
                  }}
                >
                  {vListRenderer}
                </VList>
              </div>
            )}
          </>
        </div>
        <div className="w-full pt-2 text-center">
          {isFetching ? (
            <div className="text-center">
              <div className="mx-auto h-4 w-4 animate-spin rounded-full border-2 border-ax-tertiary border-t-transparent" />
            </div>
          ) : (
            <div className="h-2" />
          )}
        </div>
      </>
    );
  },
  () => true,
);

export const MailLabels = memo(
  function MailListLabels({ labels }: { labels: { id: string; name: string }[] }) {
    if (!labels?.length) return null;

    const visibleLabels = labels.filter(
      (label) => !['unread', 'inbox'].includes(label.name.toLowerCase()),
    );

    if (!visibleLabels.length) return null;

    return (
      <div className={cn('flex select-none items-center')}>
        {visibleLabels.map((label) => {
          const style = getDefaultBadgeStyle(label.name);
          if (label.name.toLowerCase() === 'notes') {
            return (
              <Tooltip key={label.id}>
                <TooltipTrigger asChild>
                  <Badge className="rounded-md bg-amber-100 p-1 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-400">
                    {getLabelIcon(label.name)}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="hidden px-1 py-0 text-xs">
                  {m['common.notes.title']()}
                </TooltipContent>
              </Tooltip>
            );
          }

          // Skip rendering if style is "secondary" (default case)
          if (style === 'secondary') return null;
          const content = getLabelIcon(label.name);

          return content ? (
            <Badge key={label.id} className="rounded-md p-1" variant={style}>
              {content}
            </Badge>
          ) : null;
        })}
      </div>
    );
  },
  (prev, next) => {
    return JSON.stringify(prev.labels) === JSON.stringify(next.labels);
  },
);

function getLabelIcon(label: string) {
  const normalizedLabel = label.toLowerCase().replace(/^category_/i, '');

  switch (normalizedLabel) {
    case 'starred':
      return <Star className="h-[12px] w-[12px] fill-yellow-400 stroke-yellow-400" />;
    default:
      return null;
  }
}

function getDefaultBadgeStyle(label: string): ComponentProps<typeof Badge>['variant'] {
  const normalizedLabel = label.toLowerCase().replace(/^category_/i, '');

  switch (normalizedLabel) {
    case 'starred':
    case 'important':
      return 'important';
    case 'promotions':
      return 'promotions';
    case 'personal':
      return 'personal';
    case 'updates':
      return 'updates';
    case 'work':
      return 'default';
    case 'forums':
      return 'forums';
    case 'notes':
      return 'secondary';
    default:
      return 'secondary';
  }
}

// Helper function to clean name display
const cleanNameDisplay = (name?: string) => {
  if (!name) return '';
  const match = name.match(/^[^\p{L}\p{N}.]*(.*?)[^\p{L}\p{N}.]*$/u);
  return match ? match[1] : name;
};
