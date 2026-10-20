import type {MaintenanceInventory} from '../domain/maintenance.ts';
import {inventoryReadMessage} from './repository-maintenance-view.ts';

export function RepositoryInventoryNotice({inventory,error,outdated,targetRevision,loading,disabled,retry}:{inventory?:MaintenanceInventory;error:string;outdated:boolean;targetRevision?:string;loading:boolean;disabled:boolean;retry:()=>void}) {
  if(!error&&!outdated)return null;
  return <section className="mw-inventory-notice" aria-label="文件清单状态" role="status">
    <div><strong>{error?'文件清单暂未更新':'仓库有新版本'}</strong><p>{error?inventoryReadMessage(error):`仓库已更新到 ${targetRevision?.slice(0,10)}，请更新文件清单后再检查。`}</p>
      {inventory?<p>正在显示 {inventory.source==='folder'?'上次读取的文件夹':`${inventory.revision.slice(0,10)} 版本的缓存清单`}，仍可浏览；本次未确认最新内容。</p>:<p>尚无可用文件清单，读取成功后即可浏览和检查。</p>}
      {error&&<details><summary>技术详情</summary><p>{error}</p></details>}
    </div>
    <button className="mw-button" disabled={disabled||loading} onClick={retry}>{loading?'正在重新读取…':'重新读取清单'}</button>
  </section>;
}
