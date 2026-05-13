const STORAGE_URL = 'botly_gateway_url'
const STORAGE_KEY = 'botly_gateway_key'

export interface GatewayConfig {
  url: string
  apiKey: string
}

export function loadConfig(): GatewayConfig {
  return {
    url:    localStorage.getItem(STORAGE_URL) ?? import.meta.env.VITE_GATEWAY_URL ?? 'http://localhost:9000',
    apiKey: localStorage.getItem(STORAGE_KEY) ?? import.meta.env.VITE_GATEWAY_API_KEY ?? '',
  }
}

export function saveConfig(cfg: GatewayConfig): void {
  localStorage.setItem(STORAGE_URL, cfg.url)
  localStorage.setItem(STORAGE_KEY, cfg.apiKey)
}
