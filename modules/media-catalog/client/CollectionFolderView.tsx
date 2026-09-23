import type { ModuleFolderViewProps } from '../../../src/modules/contracts'
import CollectionDetail from './collections/CollectionDetail'

export default function CollectionFolderView(props: ModuleFolderViewProps) {
  return <CollectionDetail
    key={props.folder.id}
    item={props.folder}
    onRefresh={async () => { await props.onRefresh() }}
    onSettings={props.onOpenCoreView}
    onNotice={props.onNotice}
  />
}
