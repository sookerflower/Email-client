import { useTRPC } from '@/providers/query-provider';
import { useMutation } from '@tanstack/react-query';
import { Checkbox } from '../ui/checkbox';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { useState } from 'react';
import { toast } from 'sonner';

/**
 * Credential form for the custom IMAP/SMTP provider. Submits to
 * connections.createImap, which verifies the credentials against the live
 * server (via the transport sidecar) before the connection row is created —
 * a bad host/password fails here in the form, not silently later.
 */
export const ImapConnectionForm = ({
  onSuccess,
  onBack,
}: {
  onSuccess: () => void;
  onBack: () => void;
}) => {
  const trpc = useTRPC();
  const { mutateAsync: createImap, isPending } = useMutation(
    trpc.connections.createImap.mutationOptions(),
  );

  const [form, setForm] = useState({
    email: '',
    username: '',
    password: '',
    imapHost: '',
    imapPort: '993',
    smtpHost: '',
    smtpPort: '587',
    allowInsecureTls: false,
  });
  const set = (key: keyof typeof form) => (value: string | boolean) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const imapPort = Number(form.imapPort);
    const smtpPort = Number(form.smtpPort);
    if (!Number.isInteger(imapPort) || !Number.isInteger(smtpPort)) {
      toast.error('Ports must be numbers');
      return;
    }
    try {
      await createImap({
        email: form.email.trim(),
        username: (form.username || form.email).trim(),
        password: form.password,
        imapHost: form.imapHost.trim(),
        imapPort,
        // 993/465 are implicit-TLS ports; anything else (143/587) uses STARTTLS.
        imapSecure: imapPort === 993,
        smtpHost: form.smtpHost.trim(),
        smtpPort,
        smtpSecure: smtpPort === 465,
        allowInsecureTls: form.allowInsecureTls,
      });
      toast.success('IMAP account connected');
      onSuccess();
    } catch (error) {
      toast.error((error as Error).message || 'Could not connect to the mail server');
    }
  };

  const field = (
    label: string,
    key: keyof typeof form,
    props: React.ComponentProps<typeof Input> = {},
  ) => (
    <div className="space-y-1">
      <Label htmlFor={`imap-${key}`} className="text-xs">
        {label}
      </Label>
      <Input
        id={`imap-${key}`}
        value={String(form[key])}
        onChange={(e) => set(key)(e.target.value)}
        {...props}
      />
    </div>
  );

  return (
    <form onSubmit={handleSubmit} className="mt-2 space-y-3">
      {field('Email address', 'email', { type: 'email', required: true, placeholder: 'you@school.example' })}
      {field('Username (defaults to email)', 'username', { placeholder: 'you@school.example' })}
      {field('Password', 'password', { type: 'password', required: true })}
      <div className="grid grid-cols-[1fr_90px] gap-2">
        {field('IMAP host', 'imapHost', { required: true, placeholder: 'imap.school.example' })}
        {field('Port', 'imapPort', { required: true, inputMode: 'numeric' })}
      </div>
      <div className="grid grid-cols-[1fr_90px] gap-2">
        {field('SMTP host', 'smtpHost', { required: true, placeholder: 'smtp.school.example' })}
        {field('Port', 'smtpPort', { required: true, inputMode: 'numeric' })}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Checkbox
          id="imap-allowInsecureTls"
          checked={form.allowInsecureTls}
          onCheckedChange={(checked) => set('allowInsecureTls')(checked === true)}
        />
        <Label htmlFor="imap-allowInsecureTls" className="text-xs font-normal">
          Allow self-signed certificate (less secure — only for servers you trust)
        </Label>
      </div>
      <div className="flex justify-between gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onBack} disabled={isPending}>
          Back
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Testing connection…' : 'Connect'}
        </Button>
      </div>
    </form>
  );
};
