import { createRoot } from 'react-dom/client';
import { EditorApp } from './ui/EditorApp';
import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing #root element');
}

createRoot(root).render(<EditorApp />);
