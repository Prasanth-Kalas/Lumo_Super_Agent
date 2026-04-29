[**@lumo/agent-sdk-tools**](../index.md)

***

[@lumo/agent-sdk-tools](../index.md) / index

# index

## Classes

### `abstract` LumoAgent

Defined in: agent.ts:40

#### Extended by

- [`MerchantOfRecordAgent`](#abstract-merchantofrecordagent)

#### Type Parameters

##### TManifest

`TManifest` = `unknown`

#### Constructors

##### Constructor

> **new LumoAgent**\<`TManifest`\>(`manifest`): [`LumoAgent`](#abstract-lumoagent)\<`TManifest`\>

Defined in: agent.ts:43

###### Parameters

###### manifest

`TManifest`

###### Returns

[`LumoAgent`](#abstract-lumoagent)\<`TManifest`\>

#### Properties

##### manifest

> `readonly` **manifest**: `TManifest`

Defined in: agent.ts:41

***

### `abstract` MerchantOfRecordAgent

Defined in: agent.ts:48

#### Extends

- [`LumoAgent`](#abstract-lumoagent)\<`TManifest`\>

#### Type Parameters

##### TManifest

`TManifest` = `unknown`

#### Constructors

##### Constructor

> **new MerchantOfRecordAgent**\<`TManifest`\>(`manifest`): [`MerchantOfRecordAgent`](#abstract-merchantofrecordagent)\<`TManifest`\>

Defined in: agent.ts:43

###### Parameters

###### manifest

`TManifest`

###### Returns

[`MerchantOfRecordAgent`](#abstract-merchantofrecordagent)\<`TManifest`\>

###### Inherited from

[`LumoAgent`](#abstract-lumoagent).[`constructor`](#constructor)

#### Properties

##### manifest

> `readonly` **manifest**: `TManifest`

Defined in: agent.ts:41

###### Inherited from

[`LumoAgent`](#abstract-lumoagent).[`manifest`](#manifest)

#### Methods

##### executeTransaction()

> `abstract` **executeTransaction**(`input`, `context`): `Promise`\<[`TransactionResult`](interfaces/TransactionResult.md)\>

Defined in: agent.ts:49

###### Parameters

###### input

`unknown`

###### context

[`MerchantAgentContext`](interfaces/MerchantAgentContext.md)

###### Returns

`Promise`\<[`TransactionResult`](interfaces/TransactionResult.md)\>

##### refund()

> `abstract` **refund**(`transactionId`, `amountCents?`): `Promise`\<[`RefundResult`](interfaces/RefundResult.md)\>

Defined in: agent.ts:54

###### Parameters

###### transactionId

`string`

###### amountCents?

`number`

###### Returns

`Promise`\<[`RefundResult`](interfaces/RefundResult.md)\>

##### getTransactionStatus()

> `abstract` **getTransactionStatus**(`transactionId`): `Promise`\<[`TransactionState`](type-aliases/TransactionState.md)\>

Defined in: agent.ts:59

###### Parameters

###### transactionId

`string`

###### Returns

`Promise`\<[`TransactionState`](type-aliases/TransactionState.md)\>

## Interfaces

- [TransactionResult](interfaces/TransactionResult.md)
- [RefundResult](interfaces/RefundResult.md)
- [MerchantAgentContext](interfaces/MerchantAgentContext.md)
- [ManifestValidationResult](interfaces/ManifestValidationResult.md)

## Type Aliases

- [TransactionState](type-aliases/TransactionState.md)

## Functions

- [validateMerchantManifest](functions/validateMerchantManifest.md)
- [assertValidMerchantManifest](functions/assertValidMerchantManifest.md)
