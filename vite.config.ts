import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        editor: path.resolve(__dirname, 'editor.html'),
        sandbox: path.resolve(__dirname, 'sandbox.html'),
        mapeditor: path.resolve(__dirname, 'mapeditor.html'),
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
})
