const rawGatewayUrl = import.meta.env.VITE_GATEWAY_URL?.trim()

export const environment = {
  gatewayUrl: rawGatewayUrl ? rawGatewayUrl.replace(/\/$/, '') : '',
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || '',
} as const
