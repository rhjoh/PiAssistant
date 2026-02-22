# Pi Bridge Extension

This folder contains the repository-tracked copy of the Pi gateway bridge extension.

## File

- `gateway-bridge.ts` - WebSocket bridge provider for `gateway/bridge` model.

## Install to local Pi extensions

```bash
cp clients/pi-extension/gateway-bridge.ts ~/.pi/agent/extensions/gateway-bridge.ts
```

## Enable in Pi

```bash
pi extensions enable gateway-bridge
```

## Notes

- The runtime/active file is `~/.pi/agent/extensions/gateway-bridge.ts`.
- Keep this repo copy and the runtime copy in sync when making changes.
