import { useState, useEffect, useRef, useCallback } from 'react';

export interface WSMessage {
  type: string;
  data?: unknown;
  [key: string]: unknown;
}

interface UseWebSocketOptions {
  url: string;
  onMessage?: (message: WSMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  reconnectAttempts?: number;
}

export function useWebSocket({
  url,
  onMessage,
  onConnect,
  onDisconnect,
  reconnectAttempts = 5,
}: UseWebSocketOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectCountRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  const intentionalCloseRef = useRef(false);
  const pingIntervalRef = useRef<NodeJS.Timeout>();
  const pingTimestampRef = useRef<number>(0);
  
  // Use refs for callbacks to avoid reconnection loops
  const callbacksRef = useRef({ onMessage, onConnect, onDisconnect });
  callbacksRef.current = { onMessage, onConnect, onDisconnect };

  const connect = useCallback(() => {
    // Don't connect if already connecting or connected
    if (wsRef.current?.readyState === WebSocket.CONNECTING || 
        wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }
    
    // Clean up any existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined;
    }
    
    setIsConnecting(true);
    intentionalCloseRef.current = false;
    
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setIsConnecting(false);
        reconnectCountRef.current = 0;
        callbacksRef.current.onConnect?.();
        
        // Start ping interval
        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            pingTimestampRef.current = Date.now();
            ws.send(JSON.stringify({ type: 'ping', timestamp: pingTimestampRef.current }));
          }
        }, 5000);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WSMessage;
          
          // Handle pong for latency calculation
          if (message.type === 'pong') {
            const now = Date.now();
            const pingTime = pingTimestampRef.current;
            if (pingTime > 0) {
              setLatency(now - pingTime);
            }
          }
          
          callbacksRef.current.onMessage?.(message);
        } catch (err) {
          console.error('[WebSocket] Failed to parse message:', err);
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        setIsConnecting(false);
        setLatency(null);
        
        // Clear ping interval
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = undefined;
        }
        
        // Only call onDisconnect and attempt reconnect if this wasn't an intentional close
        if (!intentionalCloseRef.current) {
          callbacksRef.current.onDisconnect?.();
          
          if (reconnectCountRef.current < reconnectAttempts) {
            reconnectCountRef.current++;
            const delay = Math.min(1000 * Math.pow(2, reconnectCountRef.current), 30000);
            reconnectTimeoutRef.current = setTimeout(connect, delay);
          }
        }
      };

      ws.onerror = () => {
        // Error handling is done in onclose
      };
    } catch (err) {
      setIsConnecting(false);
      
      // Schedule reconnect on error
      if (reconnectCountRef.current < reconnectAttempts) {
        reconnectCountRef.current++;
        const delay = Math.min(1000 * Math.pow(2, reconnectCountRef.current), 30000);
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      }
    }
  }, [url, reconnectAttempts]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = undefined;
    }
    
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined;
    }
    
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const send = useCallback((message: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    connect();
    return () => {
      intentionalCloseRef.current = true;
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  return { isConnected, isConnecting, latency, send, connect, disconnect };
}
