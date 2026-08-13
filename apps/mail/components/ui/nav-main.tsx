import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from './sidebar';
import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useCommandPalette } from '../context/command-palette-context.jsx';
import { LabelDialog } from '@/components/labels/label-dialog';
import { useActiveConnection } from '@/hooks/use-connections';
import { useMutation, useQuery } from '@tanstack/react-query';
import Intercom, {  } from '@intercom/messenger-js-sdk';
import { useSidebar } from '../context/sidebar-context';
import { useTRPC } from '@/providers/query-provider';
import { type NavItem } from '@/config/navigation';
import type { Label as LabelType } from '@/types';
import { Link, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { useLabels } from '@/hooks/use-labels';
import { Badge } from '@/components/ui/badge';
import { useStats } from '@/hooks/use-stats';
import SidebarLabels from './sidebar-labels';
import { useCallback, useRef } from 'react';
import { BASE_URL } from '@/lib/constants';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import * as React from 'react';

interface IconProps extends React.SVGProps<SVGSVGElement> {
  ref?: React.Ref<SVGSVGElement>;
  startAnimation?: () => void;
  stopAnimation?: () => void;
}
interface NavItemProps extends NavItem {
  isActive?: boolean;
  isExpanded?: boolean;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  suffix?: React.ComponentType<IconProps>;
  isSettingsPage?: boolean;
}

interface NavMainProps {
  items: {
    title: string;
    items: NavItemProps[];
    isActive?: boolean;
  }[];
}

type IconRefType = SVGSVGElement & {
  startAnimation?: () => void;
  stopAnimation?: () => void;
};

export function NavMain({ items }: NavMainProps) {
  const location = useLocation();
  const pathname = location.pathname;
  const searchParams = new URLSearchParams();

  const trpc = useTRPC();
  const { data: intercomToken } = useQuery(trpc.user.getIntercomToken.queryOptions());

  React.useEffect(() => {
    if (intercomToken) {
      Intercom({
        app_id: 'aavenrba',
        intercom_user_jwt: intercomToken,
      });
    }
  }, [intercomToken]);

  const { mutateAsync: createLabel } = useMutation(trpc.labels.create.mutationOptions());

  const { userLabels, refetch } = useLabels();

  const { state } = useSidebar();

  // Check if these are bottom navigation items by looking at the first section's title
  const isBottomNav = items[0]?.title === '';

  /**
   * Validates URLs to prevent open redirect vulnerabilities.
   * Only allows two types of URLs:
   * 1. Absolute paths that start with '/' (e.g., '/mail', '/settings')
   * 2. Full URLs that match our application's base URL
   *
   * @param url - The URL to validate
   * @returns boolean - True if the URL is internal and safe to use
   */
  const isValidInternalUrl = useCallback((url: string) => {
    if (!url) return false;
    // Accept absolute paths as they are always internal
    if (url.startsWith('/')) return true;
    try {
      const urlObj = new URL(url, BASE_URL);
      // Prevent redirects to external domains by checking against our base URL
      return urlObj.origin === BASE_URL;
    } catch {
      return false;
    }
  }, []);

  const getHref = useCallback(
    (item: NavItemProps) => {
      // Get the current 'from' parameter
      const currentFrom = searchParams.get('from');

      // Handle settings navigation
      if (item.isSettingsButton) {
        // Include current path with category query parameter if present
        const currentPath = pathname;
        return `${item.url}?from=${encodeURIComponent(currentPath)}`;
      }

      // Handle back button with redirect protection
      if (item.isBackButton) {
        if (currentFrom) {
          const decodedFrom = decodeURIComponent(currentFrom);
          if (isValidInternalUrl(decodedFrom)) {
            return decodedFrom;
          }
        }
        // Fall back to safe default if URL is missing or invalid
        return '/mail';
      }

      // Handle settings pages navigation
      if (item.isSettingsPage && currentFrom) {
        // Validate and sanitize the 'from' parameter to prevent open redirects
        const decodedFrom = decodeURIComponent(currentFrom);
        if (isValidInternalUrl(decodedFrom)) {
          return `${item.url}?from=${encodeURIComponent(currentFrom)}`;
        }
        // Fall back to safe default if URL validation fails
        return `${item.url}?from=/mail`;
      }

      return item.url;
    },
    [pathname, searchParams, isValidInternalUrl],
  );

  const { data: activeAccount } = useActiveConnection();

  const isUrlActive = useCallback(
    (url: string) => {
      const urlObj = new URL(
        url,
        typeof window === 'undefined' ? BASE_URL : window.location.origin,
      );
      const cleanPath = pathname.replace(/\/$/, '');
      const cleanUrl = urlObj.pathname.replace(/\/$/, '');

      if (cleanPath !== cleanUrl) return false;

      const urlParams = new URLSearchParams(urlObj.search);
      const currentParams = new URLSearchParams(searchParams);

      for (const [key, value] of urlParams) {
        if (currentParams.get(key) !== value) return false;
      }
      return true;
    },
    [pathname, searchParams],
  );

  const onSubmit = async (data: LabelType) => {
    try {
      const promise = createLabel(data).then(async (result) => {
        await refetch();
        return result;
      });
      
      toast.promise(promise, {
        loading: 'Creating label...',
        success: 'Label created successfully',
        error: 'Failed to create label',
      });
      
      await promise;
    } catch (error) {
      console.error('Failed to create label:', error);
    }
  };

  return (
    <SidebarGroup className={`${state !== 'collapsed' ? '' : 'mt-1'} space-y-2.5 py-0 md:px-0`}>
      <SidebarMenu>
        {items.map((section) => (
          <Collapsible
            key={section.title}
            defaultOpen={section.isActive}
            className="group/collapsible"
          >
            <SidebarMenuItem>
              {state !== 'collapsed' ? (
                section.title ? (
                  <p className="ax-type-micro mx-2 mb-2 uppercase text-ax-tertiary">
                    {section.title}
                  </p>
                ) : null
              ) : (
                <div className="mx-2 mb-4 mt-2 h-px bg-ax-border" />
              )}
              <div className="z-20 space-y-1 pb-2">
                {section.items.map((item) => (
                  <NavItem
                    key={item.url}
                    {...item}
                    isActive={isUrlActive(item.url)}
                    href={getHref(item)}
                    target={item.target}
                    title={item.title}
                  />
                ))}
              </div>
            </SidebarMenuItem>
          </Collapsible>
        ))}
        {!pathname.includes('/settings') && !isBottomNav && state !== 'collapsed' && (
          <Collapsible defaultOpen={true} className="group/collapsible flex-col">
            <SidebarMenuItem className="mb-4" style={{ height: 'auto' }}>
              <div className="mx-2 mb-2 flex items-center justify-between">
                <span className="ax-type-micro uppercase text-ax-tertiary">
                  {/* IMAP reads "Labels" like Google: the app only creates
                      $zl_ keyword labels, never real IMAP folders, so a
                      "Folders" heading over this list is misleading. */}
                  {activeAccount?.providerId === 'microsoft' ? 'Folders' : 'Labels'}
                </span>
                {activeAccount?.providerId === 'microsoft' ? null : (
                  <LabelDialog
                    trigger={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="ax-pressable mr-1 h-4 w-4 rounded-[4px] p-0 text-ax-tertiary hover:bg-transparent hover:text-ax-primary focus-visible:ring-2 focus-visible:ring-ax-ring"
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    }
                    onSubmit={onSubmit}
                  />
                )}
              </div>

              {activeAccount ? (
                <>
                  <SidebarLabels data={userLabels ?? []} />
                  {activeAccount.providerId !== 'microsoft' &&
                  userLabels &&
                  userLabels.length === 0 ? (
                    <div className="ax-type-small mx-2 mt-0.5 rounded-ax-control border border-dashed border-ax-border px-2.5 py-2 text-ax-tertiary">
                      Labels tag and filter your mail — press{' '}
                      <span className="text-ax-secondary">+</span> to create one.
                    </div>
                  ) : null}
                </>
              ) : null}
            </SidebarMenuItem>
          </Collapsible>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function NavItem(item: NavItemProps & { href: string }) {
  const iconRef = useRef<IconRefType>(null);
  const { data: stats } = useStats();
  const { clearAllFilters } = useCommandPalette();

  const { state, setOpenMobile } = useSidebar();

  if (item.disabled) {
    return (
      <SidebarMenuButton
        tooltip={state === 'collapsed' ? item.title : undefined}
        className="flex cursor-not-allowed items-center opacity-50"
      >
        {item.icon && <item.icon ref={iconRef} className="relative mr-2.5 h-3 w-3.5" />}
        <p className="relative bottom-px mt-0.5 truncate text-[13px]">{item.title}</p>
      </SidebarMenuButton>
    );
  }

  const handleClick = (e: React.MouseEvent) => {
    if (item.onClick) {
      item.onClick(e as React.MouseEvent<HTMLAnchorElement>);
    }
    clearAllFilters();
    setOpenMobile(false);
  };

  return (
    <Collapsible defaultOpen={item.isActive}>
      <CollapsibleTrigger asChild>
        <SidebarMenuButton
          asChild
          tooltip={state === 'collapsed' ? item.title : undefined}
          className={cn(
            'ax-pressable flex items-center rounded-ax-control text-ax-secondary hover:bg-ax-hover hover:text-ax-primary focus-visible:ring-2 focus-visible:ring-ax-ring active:bg-ax-active',
            item.isActive &&
              'bg-ax-selected font-[var(--ax-weight-medium)] text-ax-primary hover:bg-ax-selected',
          )}
          onClick={handleClick}
        >
          <Link target={item.target} to={item.href}>
            {item.icon && <item.icon ref={iconRef} className="mr-2 shrink-0" />}
            <p className="ax-type-ui relative bottom-px mt-0.5 min-w-0 flex-1 truncate">
              {item.title}
            </p>
            {stats &&
              stats.some((stat) => stat.label?.toLowerCase() === item.id?.toLowerCase()) && (
                <Badge className="ax-type-small ml-auto shrink-0 rounded-full border-none bg-transparent px-0 font-[var(--ax-weight-normal)] tabular-nums text-ax-tertiary">
                  {stats
                    .find((stat) => stat.label?.toLowerCase() === item.id?.toLowerCase())
                    ?.count?.toLocaleString() || '0'}
                </Badge>
              )}
          </Link>
        </SidebarMenuButton>
      </CollapsibleTrigger>
    </Collapsible>
  );
}
