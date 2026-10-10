// src/settings/memory/MemoryPanel.tsx — 设置窗口的"记忆管理"面板：五个子标签（消息浏览、实体列表、摘要列表、Embedding 状态、按时间段删除）；无活跃会话时只显示提示
// 用法：SettingsApp 渲染 <MemoryPanel sessionId />，再按子标签渲染对应子组件
// 形状：props { sessionId: string | null }
// 对应文件：src/settings/SettingsApp.tsx / src/settings/memory/MessageBrowser.tsx / src/settings/memory/EntityList.tsx / src/settings/memory/SummaryList.tsx / src/settings/memory/EmbeddingQueueStatus.tsx / src/settings/memory/ForgetRangePanel.tsx
import React, { useState } from 'react'
import { MessageBrowser } from './MessageBrowser'
import { EntityList } from './EntityList'
import { SummaryList } from './SummaryList'
import { EmbeddingQueueStatusView } from './EmbeddingQueueStatus'
import { ForgetRangePanel } from './ForgetRangePanel'

type SubTab = 'messages' | 'entities' | 'summaries' | 'embedding' | 'forget'

interface MemoryPanelProps {
  sessionId: string | null
}

const SUB_TABS: Array<{ key: SubTab; label: string }> = [
  { key: 'messages', label: '消息浏览' },
  { key: 'entities', label: '实体列表' },
  { key: 'summaries', label: '摘要列表' },
  { key: 'embedding', label: 'Embedding 状态' },
  { key: 'forget', label: '按时间段删除' },
]

export function MemoryPanel({ sessionId }: MemoryPanelProps) {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('messages')

  if (!sessionId) {
    return <div className="memory-panel__empty">当前无活跃会话</div>
  }

  return (
    <div className="memory-panel">
      <div className="memory-subtabs">
        {SUB_TABS.map(tab => (
          <button
            key={tab.key}
            className={`memory-subtab${activeSubTab === tab.key ? ' memory-subtab--active' : ''}`}
            onClick={() => setActiveSubTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="memory-panel__content">
        {activeSubTab === 'messages' && <MessageBrowser sessionId={sessionId} />}
        {activeSubTab === 'entities' && <EntityList sessionId={sessionId} />}
        {activeSubTab === 'summaries' && <SummaryList sessionId={sessionId} />}
        {activeSubTab === 'embedding' && <EmbeddingQueueStatusView />}
        {activeSubTab === 'forget' && <ForgetRangePanel sessionId={sessionId} />}
      </div>
    </div>
  )
}
