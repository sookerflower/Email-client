import {
  LogOut,
  MoonIcon,
  Settings,
  Plus,
  CopyCheckIcon,
  RefreshCcw,
  Trash2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useActiveConnection, useConnections } from '@/hooks/use-connections';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDoState } from '@/components/mail/use-do-state';
import { useLoading } from '../context/loading-context';
import { signOut, useSession } from '@/lib/auth-client';
import { AddConnectionDialog } from '../connection/add';
import { CircleCheck, ThreeDots } from '../icons/icons';
import { useTRPC } from '@/providers/query-provider';
import { useSidebar } from '@/components/ui/sidebar';
import { SunIcon } from '../icons/animated/sun';
import { clear as idbClear } from 'idb-keyval';
import { useLocation } from 'react-router';
import { m } from '@/paraglide/messages';
import { useTheme } from 'next-themes';
import { useQueryState } from 'nuqs';
import { Button } from './button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const bytesToMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);

interface SyncingStatusIndicatorProps {
  isSyncing: boolean;
  storageSize: number;
  syncingFolders: string[];
}

function SyncingStatusIndicator({
  isSyncing,
  storageSize,
  syncingFolders,
}: SyncingStatusIndicatorProps) {
  const statusContent = (
    <div className="flex items-center gap-2">
      <div className="flex h-4 w-4 items-center justify-center">
        <div
          className={cn(
            'h-2 w-2 rounded-full',
            isSyncing || storageSize === 0 ? 'animate-pulse bg-ax-warning' : 'bg-ax-success',
          )}
        />
      </div>
      <p className="text-[13px] opacity-60">
        {isSyncing || storageSize === 0
          ? 'Syncing emails...'
          : `Synced${storageSize ? ` • ${bytesToMB(storageSize)} MB` : ''}`}
      </p>
    </div>
  );

  if (isSyncing && syncingFolders.length > 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuItem className="cursor-default">{statusContent}</DropdownMenuItem>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={10} avoidCollisions={false}>
          <p className="text-xs">Syncing: {syncingFolders.join(', ')}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return <DropdownMenuItem className="cursor-default">{statusContent}</DropdownMenuItem>;
}

export function NavUser() {
  const { data: session } = useSession();
  const { data } = useConnections();
  const [isRendered, setIsRendered] = useState(false);
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { state } = useSidebar();
  const trpc = useTRPC();
  const [, setThreadId] = useQueryState('threadId');
  const { mutateAsync: setDefaultConnection } = useMutation(
    trpc.connections.setDefault.mutationOptions(),
  );
  const { mutateAsync: handleForceSync } = useMutation(trpc.mail.forceSync.mutationOptions());
  const pathname = useLocation().pathname;
  const queryClient = useQueryClient();
  const { data: activeConnection, refetch: refetchActiveConnection } = useActiveConnection();
  const [category] = useQueryState('category', { defaultValue: 'All Mail' });
  const { setLoading } = useLoading();
  const [{ isSyncing, syncingFolders, storageSize, shards }] = useDoState();

  const getSettingsHref = useCallback(() => {
    const currentPath = category
      ? `${pathname}?category=${encodeURIComponent(category)}`
      : pathname;
    return `/settings/general?from=${encodeURIComponent(currentPath)}`;
  }, [pathname, category]);

  const handleClearCache = useCallback(async () => {
    queryClient.clear();
    await idbClear();
    toast.success('Cache cleared successfully');
  }, []);

  const handleCopyConnectionId = useCallback(async () => {
    await navigator.clipboard.writeText(activeConnection?.id || '');
    toast.success('Connection ID copied to clipboard');
  }, [activeConnection]);

  const { data: activeAccount } = useActiveConnection();

  useEffect(() => setIsRendered(true), []);

  const handleAccountSwitch = (connectionId: string) => async () => {
    if (connectionId === activeConnection?.id) return;

    try {
      setLoading(true, m['common.navUser.switchingAccounts']());
      setThreadId(null);
      await setDefaultConnection({ connectionId });
      queryClient.clear();
      await queryClient.refetchQueries({ queryKey: trpc.mail.listThreads.infiniteQueryKey() });
    } catch (error) {
      console.error('Error switching accounts:', error);
      toast.error(m['common.navUser.failedToSwitchAccount']());

      await refetchActiveConnection();
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    toast.promise(signOut(), {
      loading: 'Signing out...',
      success: () => 'Signed out successfully!',
      error: 'Error signing out',
      async finally() {
        // Clear the persisted query cache on the way out: the IDB cache
        // outlives the session, and a survivor from this user becomes the
        // next user's identity on a shared browser profile (the stale
        // getDefault → wrong chip + SSE/chat 403 loop bug).
        await handleClearCache();
        window.location.href = '/login';
      },
    });
  };

  const otherConnections = useMemo(() => {
    if (!data || !activeAccount) return [];
    return data.connections.filter((connection) => connection.id !== activeAccount?.id);
  }, [data, activeAccount]);

  const handleThemeToggle = () => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  if (!isRendered) return null;
  if (!session) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {state === 'collapsed' ? (
          activeAccount && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <div className="ax-pressable flex cursor-pointer items-center">
                  <div className="relative">
                    <Avatar className="relative left-0.5 size-7 rounded-ax-control">
                      <AvatarImage
                        className="rounded-ax-control"
                        src={activeAccount?.picture || undefined}
                        alt={activeAccount?.name || activeAccount?.email}
                      />

                      <AvatarFallback className="rounded-ax-control text-[10px]">
                        {(activeAccount?.name || activeAccount?.email || '')
                          .split(' ')
                          .map((n: string) => n[0])
                          .join('')
                          .toUpperCase()
                          .slice(0, 2)}
                      </AvatarFallback>
                    </Avatar>
                  </div>
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-(--radix-dropdown-menu-trigger-width) ml-3 min-w-56 ax-type-ui border-ax-border bg-ax-overlay text-ax-primary shadow-ax-popover"
                align="end"
                side={'bottom'}
                sideOffset={8}
              >
                {session && activeAccount && (
                  <>
                    <div className="flex flex-col items-center p-3 text-center">
                      <Avatar className="border-border/50 mb-2 size-14 rounded-xl border">
                        <AvatarImage
                          className="rounded-xl"
                          src={
                            (activeAccount.picture ?? undefined) ||
                            (session.user.image ?? undefined)
                          }
                          alt={activeAccount.name || session.user.name || 'User'}
                        />
                        <AvatarFallback className="rounded-xl">
                          <span>
                            {(activeAccount.name || session.user.name || 'User')
                              .split(' ')
                              .map((n) => n[0])
                              .join('')
                              .toUpperCase()
                              .slice(0, 2)}
                          </span>
                        </AvatarFallback>
                      </Avatar>
                      <div className="w-full">
                        <div className="flex items-center justify-center gap-0.5 text-sm font-medium">
                          {activeAccount.name || session.user.name || 'User'}
                        </div>
                        <div className="text-muted-foreground text-xs">{activeAccount.email}</div>
                      </div>
                    </div>
                    <DropdownMenuSeparator />
                  </>
                )}
                <div className="space-y-1">
                  <>
                    <p className="text-muted-foreground px-2 py-1 text-[11px] font-medium">
                      {m['common.navUser.accounts']()}
                    </p>

                    {data?.connections
                      ?.filter((connection) => connection.id !== activeConnection?.id)
                      .map((connection) => (
                        <DropdownMenuItem
                          key={connection.id}
                          onClick={handleAccountSwitch(connection.id)}
                          className="ax-pressable flex cursor-pointer items-center gap-3 py-1"
                        >
                          <Avatar className="size-7 rounded-lg">
                            <AvatarImage
                              className="rounded-lg"
                              src={connection.picture || undefined}
                              alt={connection.name || connection.email}
                            />
                            <AvatarFallback className="rounded-lg text-[10px]">
                              {(connection.name || connection.email)
                                .split(' ')
                                .map((n) => n[0])
                                .join('')
                                .toUpperCase()
                                .slice(0, 2)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="-space-y-0.5">
                            <p className="text-[12px]">{connection.name || connection.email}</p>
                            {connection.name && (
                              <p className="text-muted-foreground text-[11px]">
                                {connection.email.length > 25
                                  ? `${connection.email.slice(0, 25)}...`
                                  : connection.email}
                              </p>
                            )}
                          </div>
                        </DropdownMenuItem>
                      ))}
                    <AddConnectionDialog />

                    <DropdownMenuSeparator className="my-1" />

                    <DropdownMenuItem asChild>
                      <a href={getSettingsHref()} className="cursor-pointer">
                        <div className="flex items-center gap-2">
                          <Settings size={16} className="opacity-60" />
                          <p className="text-[13px] opacity-60">{m['common.actions.settings']()}</p>
                        </div>
                      </a>
                    </DropdownMenuItem>
                  </>
                </div>
                <>
                  <DropdownMenuSeparator className="mt-1" />
                  <p className="text-muted-foreground px-2 py-1 text-[11px] font-medium">Debug</p>
                  <DropdownMenuItem onClick={handleCopyConnectionId}>
                    <div className="flex items-center gap-2">
                      <CopyCheckIcon size={16} className="opacity-60" />
                      <p className="text-[13px] opacity-60">Copy Connection ID</p>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleClearCache}>
                    <div className="flex items-center gap-2">
                      <Trash2 size={16} className="opacity-60" />
                      <p className="text-[13px] opacity-60">Clear Local Cache</p>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleForceSync()}>
                    <div className="flex items-center gap-2">
                      <RefreshCcw size={16} className="opacity-60" />
                      <p className="text-[13px] opacity-60">Force re-sync</p>
                    </div>
                  </DropdownMenuItem>
                  <SyncingStatusIndicator
                    isSyncing={isSyncing}
                    storageSize={storageSize}
                    syncingFolders={syncingFolders}
                  />
                  <DropdownMenuItem>
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] opacity-60">Shards: {shards}</p>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="mt-1" />
                  <DropdownMenuItem onSelect={() => handleThemeToggle()} className="cursor-pointer">
                    <div className="flex w-full items-center gap-2">
                    {resolvedTheme === 'dark' ? (
                        <MoonIcon className="size-4 opacity-60" />
                      ) : (
                        <SunIcon className="size-4 opacity-60" />
                      )}
                      <p className="text-[13px] opacity-60">{m['common.navUser.appTheme']()}</p>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="cursor-pointer" onSelect={() => handleLogout()}>
                    <div className="flex items-center gap-2">
                      <LogOut size={16} className="opacity-60" />
                      <p className="text-[13px] opacity-60">{m['common.actions.logout']()}</p>
                    </div>
                  </DropdownMenuItem>
                </>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        ) : (
          <div className="flex w-full items-center justify-between">
            <div className="flex items-center gap-2">
              {data && activeAccount ? (
                <div
                  key={activeAccount.id}
                  onClick={handleAccountSwitch(activeAccount.id)}
                  className={`ax-pressable flex cursor-pointer items-center ${
                    activeAccount.id === activeConnection?.id && data.connections.length > 1
                      ? 'outline-ax-accent rounded-ax-control outline outline-2'
                      : ''
                  }`}
                >
                  <div className="relative">
                    <Avatar className="size-7 rounded-ax-control">
                      <AvatarImage
                        className="rounded-ax-control"
                        src={activeAccount.picture || undefined}
                        alt={activeAccount.name || activeAccount.email}
                      />
                      <AvatarFallback className="rounded-ax-control text-[10px]">
                        {(activeAccount.name || activeAccount.email)
                          .split(' ')
                          .map((n) => n[0])
                          .join('')
                          .toUpperCase()
                          .slice(0, 2)}
                      </AvatarFallback>
                    </Avatar>
                    {activeAccount.id === activeConnection?.id && data.connections.length > 1 && (
                      <CircleCheck className="fill-ax-accent absolute -bottom-2 -right-2 size-4 rounded-full bg-white bg-ax-base dark:bg-ax-base" />
                    )}
                  </div>
                </div>
              ) : (
                <div className="ax-pressable flex cursor-pointer items-center">
                  <div className="relative">
                    <div className="bg-muted size-6 animate-pulse rounded-ax-control" />
                  </div>
                </div>
              )}
              {otherConnections.slice(0, 2).map((connection) => (
                <Tooltip key={connection.id}>
                  <TooltipTrigger asChild>
                    <div
                      onClick={handleAccountSwitch(connection.id)}
                      className={`ax-pressable flex cursor-pointer items-center ${
                        connection.id === activeConnection?.id && otherConnections.length > 1
                          ? 'outline-ax-accent rounded-ax-control outline outline-2'
                          : ''
                      }`}
                    >
                      <div className="relative">
                        <Avatar className="size-7 rounded-ax-control">
                          <AvatarImage
                            className="rounded-ax-control"
                            src={connection.picture || undefined}
                            alt={connection.name || connection.email}
                          />
                          <AvatarFallback className="rounded-ax-control text-[10px]">
                            {(connection.name || connection.email)
                              .split(' ')
                              .map((n) => n[0])
                              .join('')
                              .toUpperCase()
                              .slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        {connection.id === activeConnection?.id && otherConnections.length > 1 && (
                          <CircleCheck className="fill-ax-accent absolute -bottom-2 -right-2 size-4 rounded-full bg-white dark:bg-black" />
                        )}
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="text-muted-foreground text-xs">
                    {connection.email}
                  </TooltipContent>
                </Tooltip>
              ))}

              {otherConnections.length > 3 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="hover:bg-muted flex h-7 w-7 cursor-pointer items-center justify-center rounded-ax-control">
                      <span className="text-[10px]">+{otherConnections.length - 3}</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    className="ml-3 min-w-56 ax-type-ui border-ax-border bg-ax-overlay text-ax-primary shadow-ax-popover"
                    align="end"
                    side={'bottom'}
                    sideOffset={8}
                  >
                    {otherConnections.slice(3).map((connection) => (
                      <DropdownMenuItem
                        key={connection.id}
                        onClick={handleAccountSwitch(connection.id)}
                        className="ax-pressable flex cursor-pointer items-center gap-3 py-1"
                      >
                        <Avatar className="size-7 rounded-lg">
                          <AvatarImage
                            className="rounded-lg"
                            src={connection.picture || undefined}
                            alt={connection.name || connection.email}
                          />
                          <AvatarFallback className="rounded-lg text-[10px]">
                            {(connection.name || connection.email)
                              .split(' ')
                              .map((n) => n[0])
                              .join('')
                              .toUpperCase()
                              .slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="-space-y-0.5">
                          <p className="text-[12px]">{connection.name || connection.email}</p>
                          {connection.name && (
                            <p className="text-muted-foreground text-[11px]">
                              {connection.email.length > 25
                                ? `${connection.email.slice(0, 25)}...`
                                : connection.email}
                            </p>
                          )}
                        </div>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              <AddConnectionDialog>
                <Button className="ax-pressable flex h-7 w-7 cursor-pointer items-center justify-center rounded-ax-control border border-dashed border-ax-border bg-transparent px-0 text-ax-tertiary hover:bg-ax-hover hover:text-ax-primary">
                  <Plus className="size-4" />
                </Button>
              </AddConnectionDialog>
            </div>

            <div className="flex items-center justify-center gap-1">
              {/* {isSessionPending ? null : !session.user.phoneNumberVerified ? (
                <SetupInboxDialog />
              ) : (
                <CallInboxDialog />
              )} */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    className={cn(
                      'ax-pressable rounded-ax-control focus-visible:ring-2 focus-visible:ring-ax-ring md:h-fit md:px-2',
                    )}
                  >
                    <ThreeDots className="fill-ax-secondary" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="ml-3 min-w-56 ax-type-ui border-ax-border bg-ax-overlay text-ax-primary shadow-ax-popover"
                  align="end"
                  side={'bottom'}
                  sideOffset={8}
                >
                  <div className="space-y-1">
                  </div>
                  <p className="text-muted-foreground px-2 py-1 text-[11px] font-medium">Debug</p>
                  <DropdownMenuItem onClick={handleCopyConnectionId}>
                    <div className="flex items-center gap-2">
                      <CopyCheckIcon size={16} className="opacity-60" />
                      <p className="text-[13px] opacity-60">Copy Connection ID</p>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleClearCache}>
                    <div className="flex items-center gap-2">
                      <Trash2 size={16} className="opacity-60" />
                      <p className="text-[13px] opacity-60">Clear Local Cache</p>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleForceSync()}>
                    <div className="flex items-center gap-2">
                      <RefreshCcw size={16} className="opacity-60" />
                      <p className="text-[13px] opacity-60">Force re-sync</p>
                    </div>
                  </DropdownMenuItem>
                  <SyncingStatusIndicator
                    isSyncing={isSyncing}
                    storageSize={storageSize}
                    syncingFolders={syncingFolders}
                  />
                  <DropdownMenuItem>
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] opacity-60">Shards: {shards}</p>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="mt-1" />
                  <DropdownMenuItem onClick={handleThemeToggle} className="cursor-pointer">
                    <div className="flex w-full items-center gap-2">
                      {theme === 'dark' ? (
                        <MoonIcon className="size-4 opacity-60" />
                      ) : (
                        <SunIcon className="size-4 opacity-60" />
                      )}
                      <p className="text-[13px] opacity-60">{m['common.navUser.appTheme']()}</p>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="cursor-pointer" onClick={handleLogout}>
                    <div className="flex items-center gap-2">
                      <LogOut size={16} className="opacity-60" />
                      <p className="text-[13px] opacity-60">{m['common.actions.logout']()}</p>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}
      </div>

      {state !== 'collapsed' && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="mt-[2px] flex flex-col items-start gap-1 space-y-1">
            <div className="flex items-center gap-1 text-[13px] leading-none text-black dark:text-white">
              <p className={cn('max-w-[14.5ch] truncate text-[13px]')}>
                {activeAccount?.name || session.user.name || 'User'}
              </p>
            </div>
            <div className="ax-type-small h-5 max-w-[200px] overflow-hidden truncate leading-none text-ax-tertiary">
              {activeAccount?.email || session.user.email}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
