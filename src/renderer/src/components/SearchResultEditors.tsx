import type { SearchSelection } from '../lib/searchNavigation'
import { useProfile } from '../profile'
import { fmtDayLabel } from '../lib/format'
import AddTodoModal from './AddTodoModal'
import AddEventModal from './AddEventModal'
import DailyNote from './DailyNote'
import Modal from './Modal'

interface Props { selection: SearchSelection | null; onClose: () => void }

export default function SearchResultEditors({ selection, onClose }: Props) {
  const { personById } = useProfile()
  const changed = () => {
    window.dispatchEvent(new Event('doneline:todos'))
    window.dispatchEvent(new Event('doneline:events'))
  }
  if (selection?.kind === 'todo') return <AddTodoModal open onClose={onClose} onCreated={changed} editTodo={selection.item} ownerId={selection.item.person_id} />
  if (selection?.kind === 'event') return <AddEventModal open onClose={onClose} onCreated={changed} editEvent={selection.item} ownerId={selection.item.person_id} />
  if (selection?.kind === 'note') {
    const note = selection.item
    const owner = personById(note.person_id)
    return <Modal title={`Note · ${fmtDayLabel(note.day)}`} open onClose={onClose}>
      <DailyNote day={note.day} personId={note.person_id} owner={owner} />
      <button className="btn-soft mt-4 w-full" onClick={onClose}>Close</button>
    </Modal>
  }
  return null
}
