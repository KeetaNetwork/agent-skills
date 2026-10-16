import XCTest
import KeetaComputeKit

/// Sample messages written by hand from compute/agent/src/rpc/types.ts.
final class RPCCodecTests: XCTestCase {
    private func line(_ text: String) -> Data { Data(text.utf8) }

    private func string(_ data: Data) -> String { String(decoding: data, as: UTF8.self) }

    // MARK: Outbound

    func testEncodesInitializeRequestOnOneLine() throws {
        let params = InitializeParams(network: .test, controlUrl: "https://control.keeta.ai", relayUrl: "https://relay.keeta.ai", nodePublicKey: "02ab", appVersion: "1.0", machineName: "Studio")
        let data = try RPCCodec.encodeRequest(id: .number(1), method: AgentRPC.Initialize.name, params: params)
        XCTAssertEqual(
            string(data),
            #"{"id":1,"jsonrpc":"2.0","method":"agent.initialize","params":{"appVersion":"1.0","controlUrl":"https://control.keeta.ai","machineName":"Studio","network":"test","nodePublicKey":"02ab","relayUrl":"https://relay.keeta.ai"}}"# + "\n"
        )
        XCTAssertEqual(data.filter { $0 == 0x0A }.count, 1)
    }

    func testEmptyParamsEncodeAsObject() throws {
        let data = try RPCCodec.encodeRequest(id: .number(7), method: AgentRPC.State.name, params: EmptyParams())
        XCTAssertEqual(string(data), #"{"id":7,"jsonrpc":"2.0","method":"agent.state","params":{}}"# + "\n")
    }

    func testPartialPolicyOmitsUnsetFields() throws {
        let data = try RPCCodec.encodeRequest(id: .number(2), method: AgentRPC.ProviderSetPolicy.name, params: ProviderPolicyUpdate(enabled: true))
        XCTAssertEqual(string(data), #"{"id":2,"jsonrpc":"2.0","method":"provider.setPolicy","params":{"enabled":true}}"# + "\n")
    }

    func testSetOfferAccessHasThreeStates() throws {
        let price = Price(inputPerMillion: "80000", outputPerMillion: "200000")
        let unchanged = try RPCCodec.encodeRequest(id: .number(3), method: AgentRPC.ModelsSetOffer.name, params: SetOfferParams(modelId: "qwen3-14b", offered: true, price: price))
        XCTAssertEqual(string(unchanged), #"{"id":3,"jsonrpc":"2.0","method":"models.setOffer","params":{"modelId":"qwen3-14b","offered":true,"price":{"inputPerMillion":"80000","outputPerMillion":"200000"}}}"# + "\n")

        let useDefault = try RPCCodec.encodeRequest(id: .number(4), method: AgentRPC.ModelsSetOffer.name, params: SetOfferParams(modelId: "qwen3-14b", offered: false, access: .useDefault))
        XCTAssertEqual(string(useDefault), #"{"id":4,"jsonrpc":"2.0","method":"models.setOffer","params":{"access":null,"modelId":"qwen3-14b","offered":false}}"# + "\n")

        let override = try RPCCodec.encodeRequest(id: .number(5), method: AgentRPC.ModelsSetOffer.name, params: SetOfferParams(modelId: "m", offered: true, access: .override(AccessPolicy(mode: .allowlist, allow: ["keeta_abc"]))))
        XCTAssertEqual(string(override), #"{"id":5,"jsonrpc":"2.0","method":"models.setOffer","params":{"access":{"allow":["keeta_abc"],"mode":"allowlist"},"modelId":"m","offered":true}}"# + "\n")
    }

    func testEncodesCreditSwaps() throws {
        let buy = try RPCCodec.encodeRequest(id: .number(10), method: AgentRPC.WalletBuyCredits.name, params: BuyCreditsParams(entropy: "ab", amount: "5000000", with: "KUSD"))
        XCTAssertEqual(string(buy), #"{"id":10,"jsonrpc":"2.0","method":"wallet.buyCredits","params":{"amount":"5000000","entropy":"ab","with":"KUSD"}}"# + "\n")
        let sell = try RPCCodec.encodeRequest(id: .number(11), method: AgentRPC.WalletSellCredits.name, params: SellCreditsParams(entropy: "ab", amount: "1000000", to: "KEUR"))
        XCTAssertEqual(string(sell), #"{"id":11,"jsonrpc":"2.0","method":"wallet.sellCredits","params":{"amount":"1000000","entropy":"ab","to":"KEUR"}}"# + "\n")
        let quote = try RPCCodec.encodeRequest(id: .number(12), method: AgentRPC.WalletCreditQuote.name, params: CreditQuoteParams(side: .buy, amount: "1000000", stablecoin: "KJPY"))
        XCTAssertEqual(string(quote), #"{"id":12,"jsonrpc":"2.0","method":"wallet.creditQuote","params":{"amount":"1000000","side":"buy","stablecoin":"KJPY"}}"# + "\n")
        let fund = try RPCCodec.encodeRequest(id: .number(13), method: AgentRPC.WalletFundBudget.name, params: FundBudgetParams(entropy: "ab", amount: "1", asset: .credits))
        XCTAssertEqual(string(fund), #"{"id":13,"jsonrpc":"2.0","method":"wallet.fundBudget","params":{"amount":"1","asset":"credits","entropy":"ab"}}"# + "\n")

        let bought = line(#"{"jsonrpc":"2.0","id":10,"result":{"exchangeId":"x1","blockHash":"AB","paid":"5000000","credits":"5000000","budgetBlockHash":"CD"}}"#)
        guard case let .success(_, body) = try RPCCodec.parse(bought) else { return XCTFail("expected success") }
        let result = try RPCCodec.decodeResult(AgentRPC.WalletBuyCredits.Result.self, from: body)
        XCTAssertEqual(result.credits, "5000000")
        XCTAssertEqual(result.budgetBlockHash, "CD")

        let settled = line(#"{"jsonrpc":"2.0","id":14,"result":{"reported":1,"settled":2}}"#)
        guard case let .success(_, settleBody) = try RPCCodec.parse(settled) else { return XCTFail("expected success") }
        let settle = try RPCCodec.decodeResult(AgentRPC.BuyerSettle.Result.self, from: settleBody)
        XCTAssertEqual(settle.reported, 1)
        XCTAssertEqual(settle.settled, 2)
    }

    func testEncodesSignDigestResultAndError() throws {
        let result = try RPCCodec.encodeResult(id: .string("a1"), result: SignDigestResult(signature: "00ff"))
        XCTAssertEqual(string(result), #"{"id":"a1","jsonrpc":"2.0","result":{"signature":"00ff"}}"# + "\n")
        let error = RPCCodec.encodeError(id: .number(9), code: RPCErrorCode.invalidParams, message: "digest must be 32 bytes")
        XCTAssertEqual(string(error), #"{"error":{"code":-32602,"message":"digest must be 32 bytes"},"id":9,"jsonrpc":"2.0"}"# + "\n")
        let nullID = RPCCodec.encodeError(id: nil, code: RPCErrorCode.parse, message: "parse")
        XCTAssertTrue(string(nullID).contains(#""id":null"#))
    }

    // MARK: Inbound classification

    func testParsesIncomingSignRequest() throws {
        let raw = line(#"{"jsonrpc":"2.0","id":12,"method":"signer.signDigest","params":{"digest":"256d61f01f6fbf9644493be0341b4f0ebd8fd14b1cfc6c1a10ae42630669290c"}}"#)
        guard case let .request(id, method, body) = try RPCCodec.parse(raw) else {
            return XCTFail("expected request")
        }
        XCTAssertEqual(id, .number(12))
        XCTAssertEqual(method, AppRPC.signDigest)
        XCTAssertEqual(try RPCCodec.decodeParams(SignDigestParams.self, from: body).digest.count, 64)
    }

    func testParsesStringIDs() throws {
        let raw = line(#"{"jsonrpc":"2.0","id":"req-1","method":"signer.signDigest","params":{"digest":"00"}}"#)
        guard case let .request(id, _, _) = try RPCCodec.parse(raw) else { return XCTFail("expected request") }
        XCTAssertEqual(id, .string("req-1"))
    }

    func testParsesErrorResponse() throws {
        let raw = line(#"{"jsonrpc":"2.0","id":3,"error":{"code":-32002,"message":"No operator account yet"}}"#)
        guard case let .failure(id, error) = try RPCCodec.parse(raw) else { return XCTFail("expected failure") }
        XCTAssertEqual(id, .number(3))
        XCTAssertEqual(error.code, RPCErrorCode.noOperator)
        XCTAssertTrue(error.isNoOperator)
    }

    func testRejectsGarbage() {
        XCTAssertThrowsError(try RPCCodec.parse(line("not json")))
        XCTAssertThrowsError(try RPCCodec.parse(line("[1,2]")))
        XCTAssertThrowsError(try RPCCodec.parse(line(#"{"jsonrpc":"1.0","id":1,"result":{}}"#)))
        XCTAssertThrowsError(try RPCCodec.parse(line(#"{"jsonrpc":"2.0","id":1}"#)))
    }

    func testDecodesStateNotification() throws {
        let raw = line(Self.stateNotification)
        guard case let .notification(method, body) = try RPCCodec.parse(raw) else { return XCTFail("expected notification") }
        guard case let .state(state) = try AgentNotification.decode(method: method, raw: body) else { return XCTFail("expected state") }

        XCTAssertEqual(state.network, .test)
        XCTAssertEqual(state.tier, .b)
        XCTAssertEqual(state.hardware?.memoryBytes, 68_719_476_736)
        XCTAssertEqual(state.wallet?.operatorAddress, "keeta_operator")
        XCTAssertEqual(state.wallet?.balances?.operatorBalance?.credits, "12500000")
        XCTAssertEqual(state.wallet?.balances?.operatorBalance?.stablecoins["KUSD"], "3000000")
        XCTAssertEqual(state.wallet?.balances?.spend.credits, "2000000")
        XCTAssertEqual(state.wallet?.asset.symbol, "credits")
        XCTAssertEqual(state.wallet?.asset.decimals, 6)
        XCTAssertEqual(state.wallet?.creditsAvailable, true)
        XCTAssertEqual(state.wallet?.stablecoins.map(\.symbol), ["KUSD", "USDC"])
        XCTAssertEqual(state.provider?.state, .outsideSchedule)
        XCTAssertEqual(state.provider?.policy.schedule.mode, .hours)
        XCTAssertEqual(state.provider?.policy.schedule.startHour, 22)
        XCTAssertEqual(state.provider?.policy.access.mode, .allowlist)
        XCTAssertEqual(state.provider?.recentJobs.first?.status, .paid)
        XCTAssertEqual(state.buyer?.endpoint, "http://127.0.0.1:11435/v1")
        XCTAssertEqual(state.buyer?.policy.maxPrice.outputPerMillion, "1000000")

        // Round trip keeps the explicit nulls the agent sends.
        let reencoded = try JSONEncoder().encode(state)
        XCTAssertEqual(try JSONDecoder().decode(AgentState.self, from: reencoded), state)
    }

    func testDecodesStateBeforeOnboarding() throws {
        let raw = line(#"{"jsonrpc":"2.0","method":"event.state","params":{"version":"0.1.0","network":"test","nodeKey":null,"onboarded":false,"controlReachable":false,"hardware":null,"tier":null,"wallet":null,"provider":null,"buyer":null}}"#)
        guard case let .notification(method, body) = try RPCCodec.parse(raw),
              case let .state(state) = try AgentNotification.decode(method: method, raw: body) else {
            return XCTFail("expected state")
        }
        XCTAssertFalse(state.onboarded)
        XCTAssertNil(state.wallet)
    }

    func testDecodesModelsListResult() throws {
        let raw = line(Self.modelsListResponse)
        guard case let .success(id, body) = try RPCCodec.parse(raw) else { return XCTFail("expected success") }
        XCTAssertEqual(id, .number(5))
        let entries = try RPCCodec.decodeResult(AgentRPC.ModelsList.Result.self, from: body)
        XCTAssertEqual(entries.count, 2)
        XCTAssertEqual(entries[0].model.diskBytes, 1932735283.2, accuracy: 0.01)
        XCTAssertEqual(entries[0].compatibility, .fits(headroomBytes: 41_000_000_000))
        XCTAssertEqual(entries[0].installed?.offer.access, nil)
        XCTAssertEqual(entries[0].installed?.offer.offered, true)
        XCTAssertEqual(entries[1].compatibility, .doesNotFit(reason: .needsCluster, shortByBytes: nil))
        XCTAssertEqual(entries[1].model.requiresCluster, true)
        XCTAssertNil(entries[1].installed)
    }

    func testDecodesNotEnoughMemory() throws {
        let compat = try JSONDecoder().decode(Compatibility.self, from: line(#"{"fits":false,"reason":"not-enough-memory","shortByBytes":4294967296}"#))
        XCTAssertEqual(compat, .doesNotFit(reason: .notEnoughMemory, shortByBytes: 4_294_967_296))
    }

    func testDecodesOtherNotifications() throws {
        let progress = line(#"{"jsonrpc":"2.0","method":"event.installProgress","params":{"modelId":"qwen3-8b","phase":"downloading","bytesDone":1024,"bytesTotal":4096}}"#)
        guard case let .notification(m1, b1) = try RPCCodec.parse(progress),
              case let .installProgress(p) = try AgentNotification.decode(method: m1, raw: b1) else { return XCTFail() }
        XCTAssertEqual(p.fraction, 0.25)
        XCTAssertTrue(p.isActive)

        let job = line(#"{"jsonrpc":"2.0","method":"event.job","params":{"jobId":"j1","role":"buyer","modelId":"qwen3-8b","counterparty":"keeta_node","inputTokens":120,"outputTokens":300,"amount":"36","status":"running","at":1760600000000}}"#)
        guard case let .notification(m2, b2) = try RPCCodec.parse(job),
              case let .job(j) = try AgentNotification.decode(method: m2, raw: b2) else { return XCTFail() }
        XCTAssertEqual(j.role, .buyer)
        XCTAssertNil(j.helper)

        let log = line(#"{"jsonrpc":"2.0","method":"event.log","params":{"level":"warn","message":"relay reconnecting"}}"#)
        guard case let .notification(m3, b3) = try RPCCodec.parse(log),
              case let .log(l) = try AgentNotification.decode(method: m3, raw: b3) else { return XCTFail() }
        XCTAssertEqual(l, LogEvent(level: .warn, message: "relay reconnecting"))

        XCTAssertEqual(try AgentNotification.decode(method: "event.future", raw: line("{}")), .unknown(method: "event.future"))
    }

    func testDecodesPairingRecordWithClaim() throws {
        let raw = line(#"{"jsonrpc":"2.0","id":8,"result":{"pairingId":"p1","codeHash":"h","masterNodeKey":"keeta_master","payTo":"keeta_operator","network":"test","createdAt":1,"expiresAt":2,"status":"claimed","claim":{"nodeKey":"keeta_helper","descriptor":{"name":"garage-box","os":"linux","osVersion":"Ubuntu 24.04","chip":"AMD Ryzen 9 + NVIDIA RTX 4090","memoryBytes":25769803776,"freeDiskBytes":500000000000},"checkString":"ABC-DEF","claimedAt":3}}}"#)
        guard case let .success(_, body) = try RPCCodec.parse(raw) else { return XCTFail() }
        let record = try RPCCodec.decodeResult(PairingRecord.self, from: body)
        XCTAssertEqual(record.status, .claimed)
        XCTAssertEqual(record.claim?.descriptor.name, "garage-box")
        XCTAssertEqual(record.claim?.descriptor.hardware.os, .linux)
        XCTAssertEqual(record.claim?.checkString, "ABC-DEF")
    }

    // MARK: Framing

    func testLineFramerSplitsAcrossChunks() {
        var framer = LineFramer()
        XCTAssertEqual(framer.append(line("{\"a\":1}\n{\"b\"")), [line("{\"a\":1}")])
        XCTAssertEqual(framer.append(line(":2}\r\n\n{\"c\":3}\n")), [line("{\"b\":2}"), line("{\"c\":3}")])
        XCTAssertEqual(framer.append(line("{\"d\"")), [])
        XCTAssertEqual(framer.finish(), line("{\"d\""))
        XCTAssertNil(framer.finish())
    }

    func testLineFramerDropsOversizedLines() {
        var framer = LineFramer(maxLineBytes: 8)
        XCTAssertEqual(framer.append(line("0123456789")), [])
        XCTAssertEqual(framer.append(line("ok\n")), [line("ok")])
    }

    // MARK: Samples

    static let stateNotification = #"""
    {"jsonrpc":"2.0","method":"event.state","params":{
      "version":"0.1.0","network":"test","nodeKey":"keeta_node","onboarded":true,"controlReachable":true,
      "hardware":{"os":"macos","osVersion":"15.1","chip":"Apple M4 Max","memoryBytes":68719476736,"freeDiskBytes":812345678901,"gpuCores":40,"machineModel":"Mac16,9","rdmaCapable":true},
      "tier":"B",
      "wallet":{"operator":"keeta_operator","spend":"keeta_spend",
        "balances":{"operator":{"credits":"12500000","kta":"1000000000000000000","stablecoins":{"KUSD":"3000000","USDC":"0"}},"spend":{"credits":"2000000","kta":"0","stablecoins":{"KUSD":"0","USDC":"0"}}},
        "asset":{"address":"keeta_credits","symbol":"credits","decimals":6},
        "creditsAvailable":true,
        "stablecoins":[{"symbol":"KUSD","name":"Keeta US Dollar","currency":"USD","address":"keeta_kusd","decimals":6},{"symbol":"USDC","name":"USD Coin","currency":"USD","address":"keeta_apna75yhhvnv4ei7ape55hndk4yepno7a7i2mhtiwahiygixjcnmvswxhnmnk","decimals":6}],
        "explorer":"https://explorer.test.keeta.com"},
      "provider":{"policy":{"enabled":true,"schedule":{"mode":"hours","startHour":22,"endHour":7},"pauseOnBattery":true,"maxConcurrentJobs":2,"access":{"mode":"allowlist","allow":["keeta_buyer"]}},
        "state":"outside-schedule","activeJobs":0,"earnedToday":"345000","earnedTotal":"9876543","tokensServedToday":120345,
        "recentJobs":[{"jobId":"j9","role":"provider","modelId":"qwen3-14b","counterparty":"keeta_buyer","inputTokens":900,"outputTokens":1500,"amount":"372","status":"paid","at":1760600000000.5,"helper":"keeta_helper"}]},
      "buyer":{"endpoint":"http://127.0.0.1:11435/v1","token":"kc_test_token","policy":{"perRequestMax":"100000","dailyMax":"5000000","allowedModels":[],"allowedProviders":[],"maxPrice":{"inputPerMillion":"500000","outputPerMillion":"1000000"}},
        "spentToday":"1200","recentJobs":[]}
    }}
    """#.replacingOccurrences(of: "\n", with: "")

    static let modelsListResponse = #"""
    {"jsonrpc":"2.0","id":5,"result":[
      {"model":{"id":"llama-3.2-3b-instruct","name":"Llama 3.2 3B Instruct","family":"llama","parameters":"3B","quantization":"4-bit","runtime":"mlx",
        "source":{"kind":"huggingface","repo":"mlx-community/Llama-3.2-3B-Instruct-4bit","revision":"main"},
        "diskBytes":1932735283.2,"memoryBytes":4294967296,"contextLength":131072,
        "license":{"name":"Llama Community License","url":"https://www.llama.com/llama3_3/license/","operatorNotes":"Display \"Built with Llama\".","attribution":"Built with Llama"},
        "suggestedPrice":{"inputPerMillion":"20000","outputPerMillion":"40000"},"tags":["small","chat"]},
       "compatibility":{"fits":true,"headroomBytes":41000000000},
       "installed":{"modelId":"llama-3.2-3b-instruct","name":"Llama 3.2 3B Instruct","path":"/models/llama","weightsHash":"abc","sizeBytes":1932735283,"installedAt":1760600000000,"custom":false,
         "offer":{"offered":true,"price":{"inputPerMillion":"20000","outputPerMillion":"40000"},"access":null}}},
      {"model":{"id":"muse-spark-open","name":"Muse Spark Open","family":"muse","parameters":"816B total / 42B active","quantization":"NVFP4","runtime":"mlx",
        "source":{"kind":"huggingface","repo":"meta-models/Muse-Spark-Open-816B-A42B","revision":"main"},
        "diskBytes":529353654272,"memoryBytes":601295421440,"contextLength":1000000,
        "license":{"name":"Muse Model License","url":"https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B","operatorNotes":"Attribution required."},
        "suggestedPrice":{"inputPerMillion":"1250000","outputPerMillion":"4250000"},"requiresCluster":true,"tags":["frontier"]},
       "compatibility":{"fits":false,"reason":"needs-cluster"},
       "installed":null}
    ]}
    """#.replacingOccurrences(of: "\n", with: "")
}
