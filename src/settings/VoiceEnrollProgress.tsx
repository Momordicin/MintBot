// src/settings/VoiceEnrollProgress.tsx — 声纹录入进行中的提示、已录句数与秒数、完成/取消按钮和录入句子列表
// 用法：VoicePanel 与 CharacterPanel 渲染 <VoiceEnrollProgress />；VoicePanel 另用导出的 EnrollSentenceList
// 对应文件：src/settings/VoicePanel.tsx / src/settings/CharacterPanel.tsx / src/settings/useCharacterPanel.ts
import React from 'react'
import { useTranslation } from 'react-i18next'

export interface EnrollSentence {
  text: string
  durationMs: number
}

export interface EnrollSpeaker {
  enrollUtterances: number
  enrollSpeechMs: number
  enrollReady: boolean
}

const MIN_ENROLL_UTTERANCES = 5
const MIN_ENROLL_SECONDS = 10

export function EnrollSentenceList({ label, sentences }: { label: string; sentences: EnrollSentence[] }) {
  const { t } = useTranslation()
  return (
    <div className="forget-panel__result">
      <div>{label}</div>
      {sentences.map((sentence, index) => (
        <div key={index}>{t('{{text}}（{{sec}} 秒）', { text: sentence.text, sec: (sentence.durationMs / 1000).toFixed(1) })}</div>
      ))}
    </div>
  )
}

interface VoiceEnrollProgressProps {
  speaker: EnrollSpeaker | null
  current: EnrollSentence[]
  completed: EnrollSentence[]
  locked: boolean
  onCommit: () => void
  onCancel: () => void
}

export function VoiceEnrollProgress({ speaker, current, completed, locked, onCommit, onCancel }: VoiceEnrollProgressProps) {
  const { t } = useTranslation()
  const remainingSentences = Math.max(0, MIN_ENROLL_UTTERANCES - (speaker?.enrollUtterances ?? 0))
  const remainingSeconds = Math.max(0, Math.ceil(MIN_ENROLL_SECONDS - (speaker?.enrollSpeechMs ?? 0) / 1000))
  return (
    <>
      <div>{t('请在安静的环境里用正常语速说完整的句子，每句 5 到 10 秒，总共 35 到 45 秒更好；至少 5 句且累计超过 10 秒才能完成')}</div>
      <div>
        {t('已录 {{n}} 句 / {{sec}} 秒', {
          n: speaker?.enrollUtterances ?? 0,
          sec: (Math.floor((speaker?.enrollSpeechMs ?? 0) / 100) / 10).toFixed(1),
        })}
      </div>
      {remainingSentences > 0 && <div>{t('还需要 {{count}} 句', { count: remainingSentences })}</div>}
      {remainingSeconds > 0 && <div>{t('还需要 {{count}} 秒', { count: remainingSeconds })}</div>}
      <button
        className="memory-btn"
        disabled={locked || !speaker || speaker.enrollUtterances < MIN_ENROLL_UTTERANCES || !speaker.enrollReady}
        onClick={onCommit}
      >
        {t('完成')}
      </button>
      <button className="memory-btn" disabled={locked} onClick={onCancel}>
        {t('取消')}
      </button>
      <EnrollSentenceList label={t('本次录入')} sentences={current} />
      {completed.length > 0 && <EnrollSentenceList label={t('上一次录入')} sentences={completed} />}
    </>
  )
}
