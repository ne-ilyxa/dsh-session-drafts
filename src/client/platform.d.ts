/**
 * Ambient module declarations for browser externals supplied by the DSH web
 * module table at runtime (see packages/client/web/src/seed.ts — the frozen
 * baseline the plugin bundle's `require` resolves against). Types are
 * structural and cover only what this plugin consumes.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType } from 'react'

  export const IconNewChatOutline16: ComponentType<{ size?: number; className?: string }>
  export const IconCloseOutline16: ComponentType<{ size?: number; className?: string }>
  export const IconPlusOutline16: ComponentType<{ size?: number; className?: string }>
}

declare module 'react-dom' {
  import type { ReactNode } from 'react'

  export function createPortal(children: ReactNode, container: Element | DocumentFragment, key?: string | null): ReactNode
}
