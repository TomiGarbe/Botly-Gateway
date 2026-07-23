import type { ChannelCatalogItem, FeatureCapabilities, Instance } from '../types'

// Para revisar datos legacy en un entorno controlado: VITE_SHOW_LEGACY_CONNECTIONS=true.
const showLegacyConnections = import.meta.env.VITE_SHOW_LEGACY_CONNECTIONS === 'true'

export function resolveFeatures(server: FeatureCapabilities | undefined): FeatureCapabilities {
  const features: FeatureCapabilities = server ?? { providerEvolution: false, providerBaileys: false, whatsappWeb: false, qrLogin: false, instagram: true, whatsappCloud: true }
  if (showLegacyConnections) return features
  return { ...features, providerEvolution: false, providerBaileys: false, whatsappWeb: false, qrLogin: false }
}

export function publicChannels(items: ChannelCatalogItem[], features: FeatureCapabilities): ChannelCatalogItem[] {
  return items.map(channel => ({ ...channel, methods: channel.methods.filter(method => method.currentConnectionType !== 'baileys' || features.whatsappWeb) })).filter(channel => channel.methods.length > 0)
}

export function publicInstances(items: Instance[], features: FeatureCapabilities): Instance[] {
  return items.filter(instance => instance.connectionType !== 'baileys' || features.whatsappWeb)
}
