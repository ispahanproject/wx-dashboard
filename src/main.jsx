import React from 'react'
import ReactDOM from 'react-dom/client'
import WeatherBriefing from './WeatherBriefing.jsx'

// Register Service Worker for offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/wx-dashboard/sw.js').catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WeatherBriefing />
  </React.StrictMode>
)
