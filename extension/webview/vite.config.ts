import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: '../media',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'main.js', assetFileNames: 'main.[ext]' } },
  },
});
