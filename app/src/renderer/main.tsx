import { createRoot } from 'react-dom/client';

function App() {
  return <div>Proxy Farm</div>;
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
