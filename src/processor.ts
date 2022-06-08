import * as ss58 from '@subsquid/ss58'
import {
  EventHandlerContext,
  Store,
  SubstrateProcessor,
} from '@subsquid/substrate-processor'
import { lookupArchive } from '@subsquid/archive-registry'
import moment from 'moment'
import axios from 'axios'
import { Account, HistoricalBalance, Transfer } from './model'
import { BalancesTransferEvent } from './types/events'

const priceCache = new Map()
const blockchain = 'kusama'
const processor = new SubstrateProcessor('kusama_balances')

processor.setBatchSize(500)
processor.setDataSource({
  archive: lookupArchive('kusama')[0].url,
  chain: 'wss://kusama-rpc.polkadot.io',
})

const logEvery = process.env.SECRET_LOG_EVERY
  ? Number(process.env.SECRET_LOG_EVERY)
  : 30000
if (logEvery > 0) {
  setInterval(() => {
    console.log({ message: 'test', param1: 'test', ts: new Date() })
  }, logEvery)
} else {
  console.log({ message: 'log every disabled', level: 'warn' })
}

processor.addEventHandler('balances.Transfer', async (ctx) => {
  const transfer = getTransferEvent(ctx)
  const tip = ctx.extrinsic?.tip || 0n
  const from = ss58.codec('kusama').encode(transfer.from)
  const to = ss58.codec('kusama').encode(transfer.to)

  const fromAcc = await getOrCreate(ctx.store, Account, from)
  fromAcc.balance = fromAcc.balance || 0n
  fromAcc.balance -= transfer.amount
  fromAcc.balance -= tip
  await ctx.store.save(fromAcc)

  const toAcc = await getOrCreate(ctx.store, Account, to)
  toAcc.balance = toAcc.balance || 0n
  toAcc.balance += transfer.amount
  await ctx.store.save(toAcc)

  const transferDate = new Date(ctx.block.timestamp)

  await ctx.store.save(
    new HistoricalBalance({
      id: `${ctx.event.id}-to`,
      account: fromAcc,
      balance: fromAcc.balance,
      date: transferDate,
    })
  )

  await ctx.store.save(
    new HistoricalBalance({
      id: `${ctx.event.id}-from`,
      account: toAcc,
      balance: toAcc.balance,
      date: transferDate,
    })
  )

  const formattedDateString = moment(transferDate.toISOString()).format(
    'DD-MM-yyyy'
  )
  const transferPrice = await getTokenPriceByDate(formattedDateString)
  await ctx.store.save(
    new Transfer({
      id: `${ctx.event.id}-transfer`,
      to: toAcc,
      from: fromAcc,
      amount: transfer.amount,
      date: transferDate,
      price: transferPrice,
    })
  )
})

processor.run()

async function getTokenPriceByDate(date: string) {
  if (priceCache.has(date)) return priceCache.get(date)

  priceCache.set(
    date,
    axios
      .get(
        `https://api.coingecko.com/api/v3/coins/${blockchain}/history?date=${date}&localization=false`
      )
      .then((res) => {
        return res.data.market_data.current_price.usd
      })
      .catch((error) => {
        console.error(error)
        priceCache.delete(date)
        return Promise.reject(error)
      })
  )

  return priceCache.get(date)
}

interface TransferEvent {
  from: Uint8Array
  to: Uint8Array
  amount: bigint
}

function getTransferEvent(ctx: EventHandlerContext): TransferEvent {
  const event = new BalancesTransferEvent(ctx)
  if (event.isV1020) {
    const [from, to, amount] = event.asV1020
    return { from, to, amount }
  } else if (event.isV1050) {
    const [from, to, amount] = event.asV1050
    return { from, to, amount }
  } else {
    const { from, to, amount } = event.asV9130
    return { from, to, amount }
  }
}

async function getOrCreate<T extends { id: string }>(
  store: Store,
  EntityConstructor: EntityConstructor<T>,
  id: string
): Promise<T> {
  let entity = await store.get<T>(EntityConstructor, {
    where: { id },
  })

  if (entity == null) {
    entity = new EntityConstructor()
    entity.id = id
  }

  return entity
}

type EntityConstructor<T> = {
  new (...args: any[]): T
}
