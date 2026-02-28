import { Wifi, WifiOff } from 'lucide-react';

interface ChatHeaderProps {
  isConnected: boolean;
  model?: string;
  provider?: string;
  contextTokens?: number;
}

export function ChatHeader({ isConnected, model, provider, contextTokens }: ChatHeaderProps) {
  return (
    <header className="border-b bg-card px-4 py-3">
      <div className="mx-auto flex max-w-5xl items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="font-medium">Pi Assistant</h1>
          {isConnected ? (
            <Wifi className="h-3 w-3 text-green-600" />
          ) : (
            <WifiOff className="h-3 w-3 text-red-500" />
          )}
        </div>

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          {model && provider && (
            <span>{provider}/{model}</span>
          )}
          {contextTokens !== undefined && (
            <span>{contextTokens.toLocaleString()} tokens</span>
          )}
        </div>
      </div>
    </header>
  );
}
