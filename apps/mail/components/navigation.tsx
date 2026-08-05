import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuList,
  NavigationMenuTrigger,
  NavigationMenuContent,
  ListItem,
} from '@/components/ui/navigation-menu';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { signIn, useSession } from '@/lib/auth-client';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { Menu } from 'lucide-react';
import { toast } from 'sonner';

const aboutLinks = [
  {
    title: 'About',
    href: '/about',
    description: 'Learn more about AxMail and our mission.',
  },
  {
    title: 'Privacy',
    href: '/privacy',
    description: 'Read our privacy policy and data handling practices.',
  },
  {
    title: 'Terms of Service',
    href: '/terms',
    description: 'Review our terms of service and usage guidelines.',
  },
];

export function Navigation() {
  const [open, setOpen] = useState(false);
  const { data: session } = useSession();
  const navigate = useNavigate();

  return (
    <>
      {/* Desktop Navigation - Hidden on mobile */}
      <header className="fixed left-[50%] z-50 hidden w-full max-w-4xl translate-x-[-50%] items-center justify-center px-4 pt-6 lg:flex">
        <nav className="border-input/50 flex w-full max-w-4xl items-center justify-between gap-2 rounded-xl border-t bg-[#1E1E1E] p-3 px-6">
          <div className="flex items-center gap-6">
            <Link to="/" className="relative bottom-1 cursor-pointer">
              <img src="/app-logo.png" alt="AxMail" width={26} height={26} className="rounded-md object-contain" />
              <span className="text-muted-foreground absolute -right-[-0.5px] text-[10px]">
                beta
              </span>
            </Link>
            <NavigationMenu>
              <NavigationMenuList className="gap-1">
                <NavigationMenuItem>
                  <NavigationMenuTrigger className="bg-transparent text-white cursor-pointer">
                    Company
                  </NavigationMenuTrigger>
                  <NavigationMenuContent>
                    <ul className="grid w-[300px] gap-3 p-4 md:w-[300px] md:grid-cols-1 lg:w-[400px]">
                      {aboutLinks.map((link) => (
                        <ListItem key={link.title} title={link.title} href={link.href}>
                          {link.description}
                        </ListItem>
                      ))}
                    </ul>
                  </NavigationMenuContent>
                </NavigationMenuItem>
                <NavigationMenuItem className="bg-transparent text-white cursor-pointer">
                  <a href="/privacy">
                    <Button variant="ghost" className="ml-1 h-9 bg-transparent">
                      Privacy
                    </Button>
                  </a>
                </NavigationMenuItem>
              </NavigationMenuList>
            </NavigationMenu>
          </div>
          <div className="flex gap-2">
            <Button
              className="h-8 bg-white text-black hover:bg-white hover:text-black cursor-pointer"
              onClick={() => {
                if (session) {
                  navigate('/mail/inbox');
                } else {
                  toast.promise(
                    signIn.social({
                      provider: 'google',
                      callbackURL: `${window.location.origin}/mail`,
                    }),
                    {
                      error: 'Login redirect failed',
                    },
                  );
                }
              }}
            >
              Get Started
            </Button>
          </div>
        </nav>
      </header>

      {/* Mobile Navigation Sheet */}
      <div className="lg:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="fixed left-4 top-6 z-50">
              <Menu className="h-6 w-6" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[300px] sm:w-[400px] dark:bg-[#111111]">
            <SheetHeader className="flex flex-row items-center justify-between">
              <SheetTitle>
                <Link to="/" onClick={() => setOpen(false)}>
                  <img
                    src="/app-logo.png"
                    alt="AxMail"
                    className="object-contain rounded-md"
                    width={26}
                    height={26}
                  />
                </Link>
              </SheetTitle>
            </SheetHeader>
            <div className="mt-8 flex flex-col space-y-3">
              <div className="flex flex-col space-y-3">
                <Link to="/" onClick={() => setOpen(false)}>
                  Home
                </Link>
                {aboutLinks.map((link) => (
                  <a key={link.title} href={link.href} className="block font-medium">
                    {link.title}
                  </a>
                ))}
              </div>
              <a
                href="/about"
                className="font-medium"
              >
                Contact Us
              </a>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}
