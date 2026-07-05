import { useParams } from 'react-router-dom';

export default function DealDetail() {
  const { id } = useParams();
  return <p className="mt-8 text-center text-gray-500">Deal {id} — detail view coming soon.</p>;
}
