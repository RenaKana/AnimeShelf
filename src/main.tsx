/// <reference types="vite/client" />
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import ConnectionNotice from './components/ConnectionNotice'
import { initDragScroll } from './lib/dragScroll'
import { ModulesProvider } from './modules/registry'
import './index.css'
import './content-first.css'
import './content-pages.css'
import './desktop-unified.css'
import './motion.css'
import { initializeMotion } from './lib/motion'

const disposeMotion = initializeMotion()
if (import.meta.hot) import.meta.hot.dispose(disposeMotion)

// 全局鼠标拖拽滚动（所有滚动容器：按住拖动 + 惯性）
initDragScroll()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ConnectionNotice />
      <ModulesProvider>
        <App />
      </ModulesProvider>
    </BrowserRouter>
  </React.StrictMode>
)
