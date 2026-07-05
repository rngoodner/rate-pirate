import { NavLink } from 'react-router-dom';

const tabs = [
  { to: '/', label: 'Flight deals', icon: '✈️' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
];

export default function TabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 mx-auto max-w-lg border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)]">
      <div className="flex justify-around">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center gap-1 px-6 py-3 text-xs font-medium ${
                isActive ? 'text-brand' : 'text-gray-500'
              }`
            }
          >
            <span className="text-xl leading-none">{tab.icon}</span>
            {tab.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
