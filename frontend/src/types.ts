export type ConnectionStatus = 'open' | 'connecting' | 'close'

export interface Instance {
  instanceName: string
  instanceId:   string
  integration:  string
  status?:      string
  connectionStatus?: ConnectionStatus
  // nested shape that Evolution sometimes returns
  instance?: {
    instanceName: string
    instanceId:   string
    state?:       ConnectionStatus
  }
}

export interface InstanceState {
  instance: {
    instanceName: string
    state: ConnectionStatus
  }
}

export interface QRResponse {
  base64?:  string
  code?:    string
  count?:   number
  qrcode?: {
    base64?: string
    code?:   string
    count?:  number
  }
}

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
  id:      string
  message: string
  type:    ToastType
}
