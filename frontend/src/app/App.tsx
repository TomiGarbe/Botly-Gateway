import { BrowserRouter } from 'react-router-dom'
import { AppProviders } from './providers/AppProviders'
import { AppRouter } from './router/AppRouter'

export function App() {
  return <BrowserRouter><AppProviders><AppRouter /></AppProviders></BrowserRouter>
}
