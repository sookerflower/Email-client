import { createContext, useContext, useState, useRef } from 'react';
import { useConversation } from '@elevenlabs/react';
// import { callServerTool } from '@/lib/server-tool';
import { useSession } from '@/lib/auth-client';
import type { ReactNode } from 'react';
import { toast } from 'sonner';

interface VoiceContextType {
  status: string;
  isInitializing: boolean;
  isSpeaking: boolean;
  hasPermission: boolean;
  lastToolCall: string | null;
  isOpen: boolean;

  startConversation: (context?: any) => Promise<void>;
  endConversation: () => Promise<void>;
  requestPermission: () => Promise<boolean>;
  sendContext: (context: any) => void;
}

const VoiceContext = createContext<VoiceContextType | undefined>(undefined);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const [hasPermission, setHasPermission] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [lastToolCall] = useState<string | null>(null);
  const [isOpen, setOpen] = useState(false);
  const [, setCurrentContext] = useState<any>(null);

  // Local Web Speech API state fallback
  const [localStatus, setLocalStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [localIsSpeaking, setLocalIsSpeaking] = useState(false);
  const recognitionRef = useRef<any>(null);

  const conversation = useConversation({
    onConnect: () => {
      setIsInitializing(false);
    },
    onDisconnect: () => {
      setIsInitializing(false);
    },
    onError: (error: string | Error) => {
      toast.error(typeof error === 'string' ? error : error.message);
      setIsInitializing(false);
    },
  });

  const agentId = import.meta.env.VITE_PUBLIC_ELEVENLABS_AGENT_ID;

  const requestPermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setHasPermission(true);
      return true;
    } catch {
      toast.error('Microphone access denied. Please enable microphone permissions in your browser.');
      setHasPermission(false);
      return false;
    }
  };

  const startWebSpeechRecognition = async () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      toast.error('Speech recognition is not supported in your browser. Please use Chrome, Edge, or Safari.');
      setIsInitializing(false);
      return;
    }

    try {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }

      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        setIsInitializing(false);
        setLocalStatus('connected');
        setLocalIsSpeaking(true);
        setOpen(true);
        toast.success('Listening... Speak now!');
      };

      recognition.onresult = (event: any) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          finalTranscript += event.results[i][0].transcript;
        }

        if (finalTranscript) {
          window.dispatchEvent(
            new CustomEvent('ai-chat-voice-input', {
              detail: { text: finalTranscript.trim() },
            }),
          );
        }
      };

      recognition.onerror = (event: any) => {
        console.error('[WebSpeechError]', event.error);
        if (event.error !== 'aborted' && event.error !== 'no-speech') {
          toast.error(`Speech recognition error: ${event.error}`);
        }
        setIsInitializing(false);
        setLocalStatus('disconnected');
        setLocalIsSpeaking(false);
      };

      recognition.onend = () => {
        setIsInitializing(false);
        setLocalStatus('disconnected');
        setLocalIsSpeaking(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err: any) {
      console.error('[StartWebSpeechError]', err);
      toast.error('Failed to start speech recognition.');
      setIsInitializing(false);
      setLocalStatus('disconnected');
    }
  };

  const startConversation = async (context?: any) => {
    if (!hasPermission) {
      const result = await requestPermission();
      if (!result) return;
      setHasPermission(result);
    }

    try {
      setIsInitializing(true);
      if (context) {
        setCurrentContext(context);
      }

      if (agentId) {
        await conversation.startSession({
          agentId: agentId,
          dynamicVariables: {
            user_name: session?.user.name.split(' ')[0] || 'User',
            user_email: session?.user.email || '',
            current_time: new Date().toLocaleString(),
            has_open_email: context?.hasOpenEmail ? 'yes' : 'no',
            current_thread_id: context?.currentThreadId || 'none',
            ...context,
          },
        });
        setOpen(true);
      } else {
        // Fallback to native Web Speech API when ElevenLabs Agent ID is not configured
        await startWebSpeechRecognition();
      }
    } catch (err: any) {
      console.warn('ElevenLabs conversation failed, falling back to Web Speech API', err);
      await startWebSpeechRecognition();
    }
  };

  const endConversation = async () => {
    try {
      if (agentId) {
        await conversation.endSession();
      }
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
      setLocalStatus('disconnected');
      setLocalIsSpeaking(false);
      setCurrentContext(null);
    } catch {
      toast.error('Failed to end conversation');
    }
  };

  const sendContext = (context: any) => {
    setCurrentContext(context);
  };

  const effectiveStatus = agentId ? conversation.status : localStatus;
  const effectiveIsSpeaking = agentId ? conversation.isSpeaking : localIsSpeaking;

  const value: VoiceContextType = {
    status: effectiveStatus,
    isInitializing,
    isSpeaking: effectiveIsSpeaking,
    hasPermission,
    lastToolCall,
    isOpen,
    startConversation,
    endConversation,
    requestPermission: requestPermission,
    sendContext,
  };

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoice() {
  const context = useContext(VoiceContext);
  if (!context) {
    throw new Error('useVoice must be used within a VoiceProvider');
  }
  return context;
}

export { VoiceContext };
