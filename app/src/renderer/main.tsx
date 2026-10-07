import { createRoot } from 'react-dom/client';
// Fonts ship inside the app (no network requests, spec §4.3). Each package
// includes the Vietnamese subset, so vi diacritics render in the same face.
import '@fontsource-variable/inter';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { App } from './App';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
