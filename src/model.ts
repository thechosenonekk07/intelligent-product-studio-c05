/** Minimal public example model; no host-workspace data or services are imported. */
export type Block = { id: string; locator: string; text: string; sourceLocator?: string; basis?: string }
export type Feature = { id: string; sourceId: string; title: string; review: '待复核' | '已确认' | '已排除'; success: string; failure: string }
export type Product = { id: string; name: string; sourceName: string; blocks: Block[]; features: Feature[] }
