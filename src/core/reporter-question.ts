import type {ProcessingWait} from "../domain/processing.ts";
export function reporterWait(wait:ProcessingWait):boolean {
 return wait.type==='user_input'&&wait.state==='open'&&!!wait.questions?.length&&wait.questions.every(q=>q.actor==='reporter'&&(!q.purpose||q.purpose==='information'));
}
