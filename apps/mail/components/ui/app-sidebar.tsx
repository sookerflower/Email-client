import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from '@/components/ui/sidebar';
import { navigationConfig, bottomNavItems } from '@/config/navigation';
// import { useTRPC } from '@/providers/query-provider';
import { useSidebar } from '@/components/ui/sidebar';
import { CreateEmail } from '../create/create-email';
// import { useMutation } from '@tanstack/react-query';
import { PencilCompose } from '../icons/icons';
import { useIsMobile } from '@/hooks/use-mobile';
import React, { useMemo, useRef } from 'react';
import { useSession } from '@/lib/auth-client';
import { useAIFullScreen } from './ai-sidebar';
import { useStats } from '@/hooks/use-stats';
import { useLocation } from 'react-router';
import { cn, FOLDERS } from '@/lib/utils';
import { m } from '@/paraglide/messages';
// import { Video } from 'lucide-react';
import { NavUser } from './nav-user';
import { NavMain } from './nav-main';
import { useQueryState } from 'nuqs';
// import { toast } from 'sonner';

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  //   const trpc = useTRPC();
  //   const { mutateAsync: createMeet } = useMutation(trpc.meet.create.mutationOptions());
  const { isFullScreen } = useAIFullScreen();
  const { data: stats } = useStats();
  const location = useLocation();
  const { data: session } = useSession();
  const { currentSection, navItems } = useMemo(() => {
    // Find which section we're in based on the pathname
    const section = Object.entries(navigationConfig).find(([, config]) =>
      location.pathname.startsWith(config.path),
    );

    const currentSection = section?.[0] || 'mail';
    if (navigationConfig[currentSection]) {
      const items = [...navigationConfig[currentSection].sections];

      if (currentSection === 'mail' && stats && stats.length) {
        if (items[0]?.items[0]) {
          items[0].items[0].badge =
            stats.find((stat) => stat.label?.toLowerCase() === FOLDERS.INBOX)?.count ?? 0;
        }
        if (items[0]?.items[3]) {
          items[0].items[3].badge =
            stats.find((stat) => stat.label?.toLowerCase() === FOLDERS.SENT)?.count ?? 0;
        }
      }

      return { currentSection, navItems: items };
    } else {
      return {
        currentSection: '',
        navItems: [],
      };
    }
  }, [location.pathname, stats]);

  const showComposeButton = currentSection === 'mail';
  const { state } = useSidebar();

  //   const handleCreateMeet = async () => {
  //     try {
  //       const {
  //         data: { id },
  //       } = await createMeet();
  //       navigator.clipboard.writeText(`https://meet.0.email/${id}`);
  //       toast.success('Meeting linked copied to clipboard');
  //     } catch (error) {
  //       console.error(error);
  //       toast.error('Failed to create meeting');
  //     }
  //   };

  return (
    <div>
      {!isFullScreen && (
        <Sidebar
          collapsible="icon"
          {...props}
          className={`bg-ax-base flex h-screen select-none flex-col items-center ${state === 'collapsed' ? '' : ''} pb-2`}
        >
          <SidebarHeader
            className={`relative top-2.5 flex flex-col gap-2 ${state === 'collapsed' ? 'px-2' : 'md:px-4'}`}
          >
            {session && <NavUser />}

            {showComposeButton && (
              <div className="flex gap-1">
                <div className={cn('w-full')}>
                  <ComposeButton />
                </div>
              </div>
            )}
          </SidebarHeader>
          <SidebarContent
            className={`scrollbar scrollbar-w-1 scrollbar-thumb-accent/40 scrollbar-track-transparent hover:scrollbar-thumb-accent scrollbar-thumb-rounded-full overflow-x-hidden py-0 pt-0 ${state !== 'collapsed' ? 'mt-5 md:px-4' : 'px-2'}`}
          >
            <div className="flex-1 py-0">
              <NavMain items={navItems} />
            </div>
          </SidebarContent>

          <SidebarFooter className={`px-0 pb-0 ${state === 'collapsed' ? 'md:px-2' : 'md:px-4'}`}>
            <NavMain items={bottomNavItems} />
          </SidebarFooter>
        </Sidebar>
      )}
    </div>
  );
}

function ComposeButton() {
  const { state } = useSidebar();
  const isMobile = useIsMobile();

  const [dialogOpen, setDialogOpen] = useQueryState('isComposeOpen');
  const [, setDraftId] = useQueryState('draftId');
  const [, setTo] = useQueryState('to');
  const [, setActiveReplyId] = useQueryState('activeReplyId');
  const [, setMode] = useQueryState('mode');

  // Close guard installed by the composer (threaded through CreateEmail).
  // This Dialog is what esc/overlay/X actually close, so the guard must be
  // consulted HERE: with unsaved content the composer opens its blocking
  // Save/Discard/Cancel dialog and the modal stays open until the user
  // chooses.
  const composeCloseGuard = useRef<(() => boolean) | null>(null);

  const handleOpenChange = async (open: boolean) => {
    if (!open && composeCloseGuard.current && !composeCloseGuard.current()) {
      return; // guard dialog opened; compose modal stays
    }
    if (!open) {
      setDialogOpen(null);
    } else {
      setDialogOpen('true');
    }
    setDraftId(null);
    setTo(null);
    setActiveReplyId(null);
    setMode(null);
  };
  return (
    <Dialog open={!!dialogOpen} onOpenChange={handleOpenChange}>
      <DialogTitle></DialogTitle>
      <DialogDescription></DialogDescription>

      <DialogTrigger asChild>
        <button
          type="button"
          className="ax-pressable relative mb-1.5 inline-flex h-8 w-full cursor-pointer items-center justify-center gap-1 self-stretch overflow-hidden rounded-ax-control bg-ax-accent text-ax-on-accent transition-[background-color,transform] duration-[var(--ax-dur-press)] ease-ax-out hover:bg-ax-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ax-bg-base)]"
        >
          {state === 'collapsed' && !isMobile ? (
            <PencilCompose className="mt-0.5 fill-current" />
          ) : (
            <div className="flex items-center justify-center gap-2.5 pl-0.5 pr-1">
              <PencilCompose className="fill-current" />
              <div className="ax-type-ui justify-start font-[var(--ax-weight-medium)] leading-none">
                {m['common.commandPalette.commands.newEmail']()}
              </div>
            </div>
          )}
        </button>
      </DialogTrigger>

      <DialogContent className="h-screen w-screen max-w-none border-none bg-ax-base p-0 shadow-none">
        <CreateEmail closeGuardRef={composeCloseGuard} />
      </DialogContent>
    </Dialog>
  );
}
