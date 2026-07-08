import { Navigate, Route, Routes } from 'react-router-dom';
import TabBar from './components/TabBar';
import DealsFeed from './pages/DealsFeed';
import DealDetail from './pages/DealDetail';
import Settings from './pages/Settings';

export default function App() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-lg flex-col bg-gray-100">
      <main className="flex-1 pb-24">
        <Routes>
          <Route path="/" element={<DealsFeed />} />
          <Route path="/deals/:id" element={<DealDetail />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <TabBar />
    </div>
  );
}
