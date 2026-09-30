import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app';
import { Toaster } from '@/components/ui/sonner';
import '@/index.css';
import { initializeI18n } from '@/i18n';

void initializeI18n().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
      <Toaster />
    </StrictMode>,
  );
});
