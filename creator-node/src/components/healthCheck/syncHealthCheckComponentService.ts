import type { Job } from 'bullmq'

const getJobInfo = (job: Job) => ({
  id: job.id,
  secondary: job.data.syncRequestParameters.baseURL,
  wallet: job.data.syncRequestParameters.data.wallet[0]
})

const makeResponse = (
  manualWaitingJobs: Job[],
  manualActiveJobs: Job[],
  recurringWaitingJobs: Job[],
  recurringActiveJobs: Job[]
) => ({
  manualWaiting: manualWaitingJobs.map(getJobInfo),
  manualActive: manualActiveJobs.map(getJobInfo),
  recurringWaiting: recurringWaitingJobs.map(getJobInfo),
  recurringActive: recurringActiveJobs.map(getJobInfo),
  manualWaitingCount: manualWaitingJobs.length,
  recurringWaitingCount: recurringWaitingJobs.length
})

/**
 * Returns information about sync queue.
 * Response: {
 *  manualWaiting: Array<{ id, secondary, wallet }>,
 *  manualActive: Array<{ id, secondary, wallet }>,
 *  recurringWaiting: Array<{ id, secondary, wallet }>,
 *  recurringActive: Array<{ id, secondary, wallet }>,
 *  manualWaitingCount: number,
 *  recurringWaitingCount: number
 * }
 */
export const syncHealthCheck = async ({ snapbackSM }: { snapbackSM: any }) => {
  const jobs = await snapbackSM.getSyncQueueJobs()
  return makeResponse(
    jobs.manualWaiting,
    jobs.manualActive,
    jobs.recurringWaiting,
    jobs.recurringActive
  )
}
