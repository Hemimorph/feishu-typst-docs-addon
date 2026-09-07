import { createRoot } from 'react-dom/client';
import { InlineApp } from './ui/InlineApp';
import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing #root element');
}

createRoot(root).render(<InlineApp />);
