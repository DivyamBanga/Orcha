import type { OrchaApi } from './index'

declare global {
  interface Window {
    orcha: OrchaApi
  }
}
