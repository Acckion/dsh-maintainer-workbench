export interface HostWorkspace { workspaceId:string; title:string; path:string }
export interface HostWorkspaces {
  pickDirectory:()=>Promise<string|null>;
  create:(input:{path:string})=>Promise<HostWorkspace>;
  source:{getSnapshot:()=>{items:readonly HostWorkspace[];state:string;phase:string;error:unknown};subscribe:(fn:()=>void)=>()=>void};
}
