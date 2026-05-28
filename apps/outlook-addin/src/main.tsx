import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// No StrictMode — its dev-only double-invoke of effects would fire the
// Office message read + preview fetch twice. Harmless but noisy; the
// add-in only ever runs one instance per pane anyway.
createRoot(document.getElementById('root')!).render(<App />);
