import type { MailManager, ManagerConfig } from './types';
import { ImapSmtpProxyMailManager } from './imap-proxy';
import { OutlookMailManager } from './microsoft';
import { GoogleMailManager } from './google';

const supportedProviders = {
  google: GoogleMailManager,
  microsoft: OutlookMailManager,
  imap: ImapSmtpProxyMailManager,
};

export const createDriver = (
  provider: keyof typeof supportedProviders | (string & {}),
  config: ManagerConfig,
): MailManager => {
  const Provider = supportedProviders[provider as keyof typeof supportedProviders];
  if (!Provider) throw new Error('Provider not supported');
  return new Provider(config);
};
