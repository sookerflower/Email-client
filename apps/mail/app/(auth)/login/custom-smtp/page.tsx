import { authClient } from '@/lib/auth-client';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useNavigate, Link } from 'react-router';
import { useState } from 'react';
import { toast } from 'sonner';

/**
 * Sign in with a custom IMAP/SMTP mail server (email + password).
 * Submits to the better-auth imap plugin endpoint, which verifies the
 * credentials against the live mail server, creates the user + mailbox
 * connection on first login, and sets a standard session cookie.
 *
 * Host fields are optional — the server falls back to its configured
 * default mail server (IMAP_DEFAULT_* env), so most users only type
 * email + password.
 */
export default function CustomSmtpLoginPage() {
  const _navigate = useNavigate();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [form, setForm] = useState({
    email: '',
    password: '',
    imapHost: '',
    imapPort: '',
    smtpHost: '',
    smtpPort: '',
    allowInsecureTls: false,
  });
  const set = (key: keyof typeof form) => (value: string | boolean) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsPending(true);
    try {
      const body: Record<string, unknown> = {
        email: form.email.trim(),
        password: form.password,
      };
      if (showAdvanced) {
        if (form.imapHost.trim()) body.imapHost = form.imapHost.trim();
        if (form.imapPort.trim()) body.imapPort = Number(form.imapPort);
        if (form.smtpHost.trim()) body.smtpHost = form.smtpHost.trim();
        if (form.smtpPort.trim()) body.smtpPort = Number(form.smtpPort);
        body.allowInsecureTls = form.allowInsecureTls;
      }
      const { error } = await authClient.$fetch('/sign-in/imap', {
        method: 'POST',
        body,
      });
      if (error) {
        toast.error(error.message || 'Could not sign in with these credentials');
        return;
      }
      window.location.href = '/mail/inbox';
    } catch (error) {
      toast.error((error as Error).message || 'Could not sign in');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="bg-ax-base flex min-h-screen w-full flex-col items-center justify-center">
      <div className="w-full max-w-[400px] space-y-6 px-4">
        <div className="space-y-1 text-center">
          <p className="ax-type-title text-3xl text-ax-primary">Custom IMAP/SMTP</p>
          <p className="text-muted-foreground text-sm">
            Sign in with your mail account. First sign-in connects the mailbox automatically.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="cs-email" className="text-xs">
              Email address
            </Label>
            <Input
              id="cs-email"
              type="email"
              required
              placeholder="you@example.com"
              value={form.email}
              onChange={(e) => set('email')(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cs-password" className="text-xs">
              Password
            </Label>
            <Input
              id="cs-password"
              type="password"
              required
              value={form.password}
              onChange={(e) => set('password')(e.target.value)}
            />
          </div>

          <button
            type="button"
            className="ax-type-small text-ax-tertiary underline underline-offset-2 hover:text-ax-primary"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? 'Hide server settings' : 'Server settings (optional)'}
          </button>

          {showAdvanced && (
            <div className="space-y-3 rounded-ax-control border border-ax-border p-3">
              <div className="grid grid-cols-[1fr_90px] gap-2">
                <div className="space-y-1">
                  <Label htmlFor="cs-imapHost" className="text-xs">
                    IMAP host
                  </Label>
                  <Input
                    id="cs-imapHost"
                    placeholder="(server default)"
                    value={form.imapHost}
                    onChange={(e) => set('imapHost')(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cs-imapPort" className="text-xs">
                    Port
                  </Label>
                  <Input
                    id="cs-imapPort"
                    inputMode="numeric"
                    placeholder="993"
                    value={form.imapPort}
                    onChange={(e) => set('imapPort')(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-[1fr_90px] gap-2">
                <div className="space-y-1">
                  <Label htmlFor="cs-smtpHost" className="text-xs">
                    SMTP host
                  </Label>
                  <Input
                    id="cs-smtpHost"
                    placeholder="(server default)"
                    value={form.smtpHost}
                    onChange={(e) => set('smtpHost')(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cs-smtpPort" className="text-xs">
                    Port
                  </Label>
                  <Input
                    id="cs-smtpPort"
                    inputMode="numeric"
                    placeholder="587"
                    value={form.smtpPort}
                    onChange={(e) => set('smtpPort')(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="cs-allowInsecureTls"
                  checked={form.allowInsecureTls}
                  onCheckedChange={(checked) => set('allowInsecureTls')(checked === true)}
                />
                <Label htmlFor="cs-allowInsecureTls" className="text-xs font-normal">
                  Allow self-signed certificate
                </Label>
              </div>
            </div>
          )}

          <Button type="submit" className="ax-pressable w-full rounded-ax-control bg-ax-accent text-ax-on-accent hover:bg-ax-accent-hover focus-visible:ring-2 focus-visible:ring-ax-ring" disabled={isPending}>
            {isPending ? 'Verifying credentials…' : 'Sign in'}
          </Button>
        </form>

        <p className="text-muted-foreground text-center text-xs">
          <Link to="/login" className="underline">
            Back to all sign-in options
          </Link>
        </p>
      </div>
    </div>
  );
}
