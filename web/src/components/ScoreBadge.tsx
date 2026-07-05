export default function ScoreBadge({ score }: { score: number }) {
  return (
    <span className="inline-block rounded-lg bg-green-50 px-2.5 py-1 text-sm font-bold text-green-600">
      {score}% deal score
    </span>
  );
}
