var device = null;
(function() {
    'use strict';

    function hex4(n) {
        let s = n.toString(16)
        while (s.length < 4) {
            s = '0' + s;
        }
        return s;
    }

    function hexAddr8(n) {
        let s = n.toString(16)
        while (s.length < 8) {
            s = '0' + s;
        }
        return "0x" + s;
    }

    function niceSize(n) {
        const gigabyte = 1024 * 1024 * 1024;
        const megabyte = 1024 * 1024;
        const kilobyte = 1024;
        if (n >= gigabyte) {
            return n / gigabyte + "GiB";
        } else if (n >= megabyte) {
            return n / megabyte + "MiB";
        } else if (n >= kilobyte) {
            return n / kilobyte + "KiB";
        } else {
            return n + "B";
        }
    }

    function readFixedAscii(view, offset, length) {
        let result = "";
        for (let i = 0; i < length; i++) {
            const value = view.getUint8(offset + i);
            if (value === 0) {
                break;
            }
            result += String.fromCharCode(value);
        }
        return result;
    }

    function parseDfuSeFile(data) {
        const view = new DataView(data);
        if (view.byteLength < 11 || readFixedAscii(view, 0, 5) !== "DfuSe") {
            return null;
        }

        const version = view.getUint8(5);
        const totalSize = view.getUint32(6, true);
        const targetCount = view.getUint8(10);
        if (version !== 0x01) {
            throw `Unsupported DfuSe version: ${version}`;
        }
        if (totalSize > view.byteLength) {
            throw `Invalid DfuSe size ${totalSize}, file is only ${view.byteLength} bytes`;
        }

        let offset = 11;
        const targets = [];
        for (let i = 0; i < targetCount; i++) {
            if (offset + 274 > totalSize) {
                throw "Truncated DfuSe target prefix";
            }

            const signature = readFixedAscii(view, offset, 6);
            if (signature !== "Target") {
                throw `Invalid DfuSe target signature at offset ${offset}: "${signature}"`;
            }

            const alternateSetting = view.getUint8(offset + 6);
            const named = view.getUint32(offset + 7, true);
            const name = readFixedAscii(view, offset + 11, 255);
            const targetSize = view.getUint32(offset + 266, true);
            const elementCount = view.getUint32(offset + 270, true);
            offset += 274;

            const targetStart = offset;
            const elements = [];
            for (let j = 0; j < elementCount; j++) {
                if (offset + 8 > totalSize) {
                    throw "Truncated DfuSe element header";
                }

                const address = view.getUint32(offset, true);
                const size = view.getUint32(offset + 4, true);
                offset += 8;
                if (offset + size > totalSize) {
                    throw `Truncated DfuSe element data at 0x${address.toString(16)}`;
                }

                elements.push({
                    address,
                    data: data.slice(offset, offset + size),
                });
                offset += size;
            }

            if (offset - targetStart !== targetSize) {
                throw `DfuSe target size mismatch for alt=${alternateSetting}`;
            }

            targets.push({
                alternateSetting,
                named,
                name,
                elements,
            });
        }

        return {version, totalSize, targets};
    }

    function formatDFUSummary(device) {
        const vid = hex4(device.device_.vendorId);
        const pid = hex4(device.device_.productId);
        const name = device.device_.productName;

        let mode = "Unknown"
        if (device.settings.alternate.interfaceProtocol == 0x01) {
            mode = "Runtime";
        } else if (device.settings.alternate.interfaceProtocol == 0x02) {
            mode = "DFU";
        }

        const cfg = device.settings.configuration.configurationValue;
        const intf = device.settings["interface"].interfaceNumber;
        const alt = device.settings.alternate.alternateSetting;
        const serial = device.device_.serialNumber;
        let info = `${mode}: [${vid}:${pid}] cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}" serial="${serial}"`;
        return info;
    }

    function formatDFUInterfaceAlternate(settings) {
        let mode = "Unknown"
        if (settings.alternate.interfaceProtocol == 0x01) {
            mode = "Runtime";
        } else if (settings.alternate.interfaceProtocol == 0x02) {
            mode = "DFU";
        }

        const cfg = settings.configuration.configurationValue;
        const intf = settings["interface"].interfaceNumber;
        const alt = settings.alternate.alternateSetting;
        const name = (settings.name) ? settings.name : "UNKNOWN";

        return `${mode}: cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}"`;
    }

    function getInterfaceOverrideKey(device_, settings) {
        const vid = hex4(device_.vendorId);
        const pid = hex4(device_.productId);
        const serial = device_.serialNumber || "";
        const cfg = settings.configuration.configurationValue;
        const intf = settings["interface"].interfaceNumber;
        const alt = settings.alternate.alternateSetting;
        return `dfu-override:${vid}:${pid}:${serial}:${cfg}:${intf}:${alt}`;
    }

    function loadInterfaceOverride(device_, settings) {
        return localStorage.getItem(getInterfaceOverrideKey(device_, settings));
    }

    function saveInterfaceOverride(device_, settings, value) {
        const key = getInterfaceOverrideKey(device_, settings);
        if (value) {
            localStorage.setItem(key, value);
        } else {
            localStorage.removeItem(key);
        }
    }

    function getInterfaceDescriptorValue(device_, settings) {
        const override = loadInterfaceOverride(device_, settings);
        if (override) {
            return override;
        }
        if (!dfu.isMissingInterfaceName(settings.name)) {
            return settings.name;
        }
        return dfu.getSuggestedInterfaceName(device_, settings.interface, settings.alternate);
    }

    function applyInterfaceOverrides(device_, interfaces, form) {
        for (let i = 0; i < interfaces.length; i++) {
            const field = form.elements[`interfaceName${i}`];
            if (!field) {
                continue;
            }

            const value = field.value.trim();
            interfaces[i].name = value || null;
            saveInterfaceOverride(device_, interfaces[i], value);
        }
    }

    function getDownloadPlan(fileData, currentDevice) {
        const parsedDfu = parseDfuSeFile(fileData);
        if (!parsedDfu) {
            return {
                kind: "raw",
                data: fileData,
            };
        }

        const selectedAlt = currentDevice.settings.alternate.alternateSetting;
        let matchingTargets = parsedDfu.targets.filter(target => target.alternateSetting === selectedAlt);
        if (matchingTargets.length === 0) {
            matchingTargets = parsedDfu.targets;
        }

        const elements = [];
        for (const target of matchingTargets) {
            for (const element of target.elements) {
                elements.push(element);
            }
        }

        if (elements.length === 0) {
            throw "Selected DfuSe file does not contain any downloadable elements";
        }

        return {
            kind: "dfuse",
            targets: matchingTargets,
            elements,
        };
    }

    function parseMemoryDescriptorForWizard(desc) {
        const nameEndIndex = desc.indexOf("/");
        if (!desc.startsWith("@") || nameEndIndex == -1) {
            throw `Not a DfuSe memory descriptor: "${desc}"`;
        }

        const name = desc.substring(1, nameEndIndex).trim();
        const segmentString = desc.substring(nameEndIndex);
        const rows = [];
        const groupRegex = /\/\s*(0x[0-9a-fA-F]{1,8})\s*\/((?:\s*[0-9]+\s*\*\s*[0-9]+\s?[ BKM]\s*[abcdefg]\s*,?\s*)+)/g;
        const rowRegex = /([0-9]+)\s*\*\s*([0-9]+)\s?([ BKM])\s*([abcdefg])\s*,?\s*/g;

        let groupMatch;
        while ((groupMatch = groupRegex.exec(segmentString)) !== null) {
            let start = parseInt(groupMatch[1], 16);
            let rowMatch;
            while ((rowMatch = rowRegex.exec(groupMatch[2])) !== null) {
                rows.push({
                    start: start,
                    count: parseInt(rowMatch[1], 10),
                    size: parseInt(rowMatch[2], 10),
                    unit: rowMatch[3].trim() || "B",
                    access: rowMatch[4]
                });

                const unitMultiplier = {"B": 1, "K": 1024, "M": 1048576}[rowMatch[3].trim() || "B"];
                start += parseInt(rowMatch[1], 10) * parseInt(rowMatch[2], 10) * unitMultiplier;
            }
        }

        return {name, rows};
    }

    function accessLetterFromFlags(readable, erasable, writable) {
        let properties = 0;
        if (readable) {
            properties |= 0x1;
        }
        if (erasable) {
            properties |= 0x2;
        }
        if (writable) {
            properties |= 0x4;
        }
        if (properties === 0) {
            throw "Select at least one access flag";
        }

        return String.fromCharCode("a".charCodeAt(0) + properties - 1);
    }

    function wizardRowsToDescriptor(name, rows) {
        const trimmedName = name.trim();
        if (!trimmedName) {
            throw "Descriptor name is required";
        }
        if (rows.length === 0) {
            throw "Add at least one region";
        }

        const parts = [`@${trimmedName}`];
        for (const row of rows) {
            if (!/^0x[0-9a-fA-F]+$/.test(row.start)) {
                throw `Invalid start address: ${row.start}`;
            }
            if (!Number.isInteger(row.count) || row.count <= 0) {
                throw "Region count must be a positive integer";
            }
            if (!Number.isInteger(row.size) || row.size <= 0) {
                throw "Region size must be a positive integer";
            }

            const access = accessLetterFromFlags(row.readable, row.erasable, row.writable);
            parts.push(`/${row.start}/${row.count.toString().padStart(2, "0")}*${row.size.toString().padStart(3, "0")}${row.unit}${access}`);
        }

        return parts.join("");
    }

    function setDescriptorStatus(statusEl, message, valid) {
        statusEl.textContent = message;
        statusEl.className = `descriptor-status ${valid ? "valid" : "invalid"}`;
    }

    function collectWizardRows(tableBody) {
        const rows = [];
        for (const tr of tableBody.querySelectorAll("tr")) {
            rows.push({
                start: tr.querySelector(".wizard-start").value.trim(),
                count: parseInt(tr.querySelector(".wizard-count").value, 10),
                size: parseInt(tr.querySelector(".wizard-size").value, 10),
                unit: tr.querySelector(".wizard-unit").value,
                readable: tr.querySelector(".wizard-readable").checked,
                erasable: tr.querySelector(".wizard-erasable").checked,
                writable: tr.querySelector(".wizard-writable").checked
            });
        }
        return rows;
    }

    function addWizardRow(tableBody, row = null) {
        const tr = document.createElement("tr");
        const access = row ? row.access : null;
        const readable = access ? ["a", "c", "e", "g"].includes(access) : true;
        const erasable = access ? ["b", "c", "f", "g"].includes(access) : true;
        const writable = access ? ["d", "e", "f", "g"].includes(access) : true;

        tr.innerHTML = `
            <td><input class="wizard-start" type="text" value="${row ? `0x${row.start.toString(16)}` : "0x08000000"}" pattern="0x[A-Fa-f0-9]+" /></td>
            <td><input class="wizard-count" type="number" min="1" value="${row ? row.count : 1}" /></td>
            <td><input class="wizard-size" type="number" min="1" value="${row ? row.size : 16}" /></td>
            <td>
                <select class="wizard-unit">
                    <option value="B"${row && row.unit === "B" ? " selected" : ""}>B</option>
                    <option value="K"${(!row || row.unit === "K") ? " selected" : ""}>K</option>
                    <option value="M"${row && row.unit === "M" ? " selected" : ""}>M</option>
                </select>
            </td>
            <td><input class="wizard-readable" type="checkbox"${readable ? " checked" : ""} /></td>
            <td><input class="wizard-erasable" type="checkbox"${erasable ? " checked" : ""} /></td>
            <td><input class="wizard-writable" type="checkbox"${writable ? " checked" : ""} /></td>
            <td><button type="button" class="wizard-remove">Remove</button></td>
        `;
        tableBody.appendChild(tr);
        return tr;
    }

    function buildInterfaceOverrideControls(device_, settings, index) {
        const wrapper = document.createElement("div");
        wrapper.className = "interface-override";

        const name = settings.name || dfu.getSuggestedInterfaceName(device_, settings.interface, settings.alternate) || "Internal Flash";
        let descriptorValue = getInterfaceDescriptorValue(device_, settings) || "";
        let wizardSeed = null;
        try {
            if (descriptorValue) {
                wizardSeed = parseMemoryDescriptorForWizard(descriptorValue);
            }
        } catch (error) {
            wizardSeed = null;
        }

        wrapper.innerHTML = `
            <div class="override-mode-switch">
                <button type="button" class="mode-toggle" data-mode="wizard">Wizard</button>
                <button type="button" class="mode-toggle active" data-mode="manual">Manual</button>
            </div>
            <div class="override-section" data-mode-section="wizard" hidden>
                <label for="interfaceWizardName${index}">Descriptor name:</label>
                <input type="text" id="interfaceWizardName${index}" value="${wizardSeed ? wizardSeed.name : name.replace(/^@/, "")}" />
                <table class="override-wizard">
                    <thead>
                        <tr>
                            <th>Start</th>
                            <th>Count</th>
                            <th>Size</th>
                            <th>Unit</th>
                            <th>Read</th>
                            <th>Erase</th>
                            <th>Write</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody id="interfaceWizardRows${index}"></tbody>
                </table>
                <div class="override-actions">
                    <button type="button" id="interfaceAddRow${index}">Add region</button>
                </div>
                <div class="descriptor-preview" id="interfacePreview${index}"></div>
                <p class="descriptor-status" id="interfaceStatus${index}"></p>
            </div>
            <div class="override-section" data-mode-section="manual">
                <label for="interfaceName${index}">Memory descriptor override:</label>
                <input type="text" name="interfaceName${index}" id="interfaceName${index}" placeholder="@Internal Flash /0x08000000/04*016Kg,01*064Kg,07*128Kg" value="${descriptorValue}" />
                <p class="descriptor-status" id="interfaceManualStatus${index}"></p>
            </div>
        `;

        const wizardSection = wrapper.querySelector('[data-mode-section="wizard"]');
        const manualSection = wrapper.querySelector('[data-mode-section="manual"]');
        const manualInput = wrapper.querySelector(`#interfaceName${index}`);
        const preview = wrapper.querySelector(`#interfacePreview${index}`);
        const status = wrapper.querySelector(`#interfaceStatus${index}`);
        const manualStatus = wrapper.querySelector(`#interfaceManualStatus${index}`);
        const wizardName = wrapper.querySelector(`#interfaceWizardName${index}`);
        const rowsBody = wrapper.querySelector(`#interfaceWizardRows${index}`);

        function validateManual() {
            const value = manualInput.value.trim();
            if (!value) {
                setDescriptorStatus(manualStatus, "No override set. Browser-provided interface name will be used.", true);
                return;
            }
            try {
                dfuse.parseMemoryDescriptor(value);
                setDescriptorStatus(manualStatus, "Descriptor valid.", true);
            } catch (error) {
                setDescriptorStatus(manualStatus, error.toString(), false);
            }
        }

        function updateWizardPreview() {
            try {
                const descriptor = wizardRowsToDescriptor(wizardName.value, collectWizardRows(rowsBody));
                preview.textContent = descriptor;
                manualInput.value = descriptor;
                setDescriptorStatus(status, "Descriptor valid.", true);
            } catch (error) {
                preview.textContent = "";
                setDescriptorStatus(status, error.toString(), false);
            }
            validateManual();
        }

        const seedRows = wizardSeed && wizardSeed.rows.length > 0 ? wizardSeed.rows : [{
            start: 0x08000000,
            count: 4,
            size: 16,
            unit: "K",
            access: "g"
        }];
        for (const row of seedRows) {
            const tr = addWizardRow(rowsBody, row);
            tr.addEventListener("input", updateWizardPreview);
            tr.querySelector(".wizard-remove").addEventListener("click", () => {
                tr.remove();
                updateWizardPreview();
            });
        }

        wrapper.querySelector(`#interfaceAddRow${index}`).addEventListener("click", () => {
            const tr = addWizardRow(rowsBody);
            tr.addEventListener("input", updateWizardPreview);
            tr.querySelector(".wizard-remove").addEventListener("click", () => {
                tr.remove();
                updateWizardPreview();
            });
            updateWizardPreview();
        });

        for (const button of wrapper.querySelectorAll(".mode-toggle")) {
            button.addEventListener("click", () => {
                for (const candidate of wrapper.querySelectorAll(".mode-toggle")) {
                    candidate.classList.toggle("active", candidate === button);
                }
                const wizardMode = button.dataset.mode === "wizard";
                wizardSection.hidden = !wizardMode;
                manualSection.hidden = wizardMode;
            });
        }

        wizardName.addEventListener("input", updateWizardPreview);
        manualInput.addEventListener("input", validateManual);

        updateWizardPreview();
        return wrapper;
    }

    async function fixInterfaceNames(device_, interfaces) {
        // Check if any interface names were not read correctly
        if (interfaces.some(intf => dfu.isMissingInterfaceName(intf.name))) {
            // Manually retrieve the interface name string descriptors
            let tempDevice = new dfu.Device(device_, interfaces[0]);
            await tempDevice.device_.open();
            await tempDevice.device_.selectConfiguration(1);
            let mapping = await tempDevice.readInterfaceNames();
            await tempDevice.close();

            for (let intf of interfaces) {
                if (dfu.isMissingInterfaceName(intf.name)) {
                    let configIndex = intf.configuration.configurationValue;
                    let intfNumber = intf["interface"].interfaceNumber;
                    let alt = intf.alternate.alternateSetting;
                    intf.name = mapping[configIndex][intfNumber][alt];
                }
            }
        }
    }

    function populateInterfaceList(form, device_, interfaces) {
        let old_choices = Array.from(form.getElementsByTagName("div"));
        for (let radio_div of old_choices) {
            form.removeChild(radio_div);
        }

        let button = form.getElementsByTagName("button")[0];

        for (let i=0; i < interfaces.length; i++) {
            let radio = document.createElement("input");
            radio.type = "radio";
            radio.name = "interfaceIndex";
            radio.value = i;
            radio.id = "interface" + i;
            radio.required = true;

            let label = document.createElement("label");
            label.textContent = formatDFUInterfaceAlternate(interfaces[i]);
            label.className = "radio"
            label.setAttribute("for", "interface" + i);

            let div = document.createElement("div");
            div.className = "interface-choice";
            div.appendChild(radio);
            div.appendChild(label);

            div.appendChild(buildInterfaceOverrideControls(device_, interfaces[i], i));

            if (dfu.isMissingInterfaceName(interfaces[i].name)) {
                let help = document.createElement("p");
                help.className = "interface-help";
                help.textContent = "Browser did not provide this interface name. Enter or confirm the descriptor before connecting.";
                div.appendChild(help);
            }

            form.insertBefore(div, button);
        }
    }

    function getDFUDescriptorProperties(device) {
        // Attempt to read the DFU functional descriptor
        // TODO: read the selected configuration's descriptor
        return device.readConfigurationDescriptor(0).then(
            data => {
                let configDesc = dfu.parseConfigurationDescriptor(data);
                let funcDesc = null;
                let configValue = device.settings.configuration.configurationValue;
                if (configDesc.bConfigurationValue == configValue) {
                    for (let desc of configDesc.descriptors) {
                        if (desc.bDescriptorType == 0x21 && desc.hasOwnProperty("bcdDFUVersion")) {
                            funcDesc = desc;
                            break;
                        }
                    }
                }

                if (funcDesc) {
                    return {
                        WillDetach:            ((funcDesc.bmAttributes & 0x08) != 0),
                        ManifestationTolerant: ((funcDesc.bmAttributes & 0x04) != 0),
                        CanUpload:             ((funcDesc.bmAttributes & 0x02) != 0),
                        CanDnload:             ((funcDesc.bmAttributes & 0x01) != 0),
                        TransferSize:          funcDesc.wTransferSize,
                        DetachTimeOut:         funcDesc.wDetachTimeOut,
                        DFUVersion:            funcDesc.bcdDFUVersion
                    };
                } else {
                    return {};
                }
            },
            error => {}
        );
    }

    // Current log div element to append to
    let logContext = null;

    function setLogContext(div) {
        logContext = div;
    };

    function clearLog(context) {
        if (typeof context === 'undefined') {
            context = logContext;
        }
        if (context) {
            context.innerHTML = "";
        }
    }

    function logDebug(msg) {
        console.log(msg);
    }

    function logInfo(msg) {
        if (logContext) {
            let info = document.createElement("p");
            info.className = "info";
            info.textContent = msg;
            logContext.appendChild(info);
        }
    }

    function logWarning(msg) {
        if (logContext) {
            let warning = document.createElement("p");
            warning.className = "warning";
            warning.textContent = msg;
            logContext.appendChild(warning);
        }
    }

    function logError(msg) {
        if (logContext) {
            let error = document.createElement("p");
            error.className = "error";
            error.textContent = msg;
            logContext.appendChild(error);
        }
    }

    function logProgress(done, total) {
        if (logContext) {
            let progressBar;
            if (logContext.lastChild && logContext.lastChild.tagName.toLowerCase() == "progress") {
                progressBar = logContext.lastChild;
            }
            if (!progressBar && done === 0) {
                return;
            }
            if (!progressBar) {
                progressBar = document.createElement("progress");
                logContext.appendChild(progressBar);
            }
            progressBar.value = done;
            if (typeof total !== 'undefined') {
                progressBar.max = total;
            }
        }
    }

    document.addEventListener('DOMContentLoaded', event => {
        let connectButton = document.querySelector("#connect");
        let detachButton = document.querySelector("#detach");
        let downloadButton = document.querySelector("#download");
        let uploadButton = document.querySelector("#upload");
        let statusDisplay = document.querySelector("#status");
        let infoDisplay = document.querySelector("#usbInfo");
        let dfuDisplay = document.querySelector("#dfuInfo");
        let vidField = document.querySelector("#vid");
        let interfaceDialog = document.querySelector("#interfaceDialog");
        let interfaceForm = document.querySelector("#interfaceForm");
        let interfaceSelectButton = document.querySelector("#selectInterface");

        let searchParams = new URLSearchParams(window.location.search);
        let fromLandingPage = false;
        let vid = 0;
        // Set the vendor ID from the landing page URL
        if (searchParams.has("vid")) {
            const vidString = searchParams.get("vid");
            try {
                if (vidString.toLowerCase().startsWith("0x")) {
                    vid = parseInt(vidString, 16);
                } else {
                    vid = parseInt(vidString, 10);
                }
                vidField.value = "0x" + hex4(vid).toUpperCase();
                fromLandingPage = true;
            } catch (error) {
                console.log("Bad VID " + vidString + ":" + error);
            }
        }

        // Grab the serial number from the landing page
        let serial = "";
        if (searchParams.has("serial")) {
            serial = searchParams.get("serial");
            // Workaround for Chromium issue 339054
            if (window.location.search.endsWith("/") && serial.endsWith("/")) {
                serial = serial.substring(0, serial.length-1);
            }
            fromLandingPage = true;
        }

        let configForm = document.querySelector("#configForm");

        let transferSizeField = document.querySelector("#transferSize");
        let transferSize = parseInt(transferSizeField.value);

        let dfuseStartAddressField = document.querySelector("#dfuseStartAddress");
        let dfuseUploadSizeField = document.querySelector("#dfuseUploadSize");

        let firmwareFileField = document.querySelector("#firmwareFile");
        let firmwareFile = null;

        let downloadLog = document.querySelector("#downloadLog");
        let uploadLog = document.querySelector("#uploadLog");

        let manifestationTolerant = true;

        //let device;

        function onDisconnect(reason) {
            if (reason) {
                statusDisplay.textContent = reason;
            }

            connectButton.textContent = "Connect";
            infoDisplay.textContent = "";
            dfuDisplay.textContent = "";
            detachButton.disabled = true;
            uploadButton.disabled = true;
            downloadButton.disabled = true;
            firmwareFileField.disabled = true;
        }

        function onUnexpectedDisconnect(event) {
            if (device !== null && device.device_ !== null) {
                if (device.device_ === event.device) {
                    device.disconnected = true;
                    onDisconnect("Device disconnected");
                    device = null;
                }
            }
        }

        async function connect(device) {
            try {
                await device.open();
            } catch (error) {
                onDisconnect(error);
                throw error;
            }

            // Attempt to parse the DFU functional descriptor
            let desc = {};
            try {
                desc = await getDFUDescriptorProperties(device);
            } catch (error) {
                onDisconnect(error);
                throw error;
            }

            let memorySummary = "";
            if (desc && Object.keys(desc).length > 0) {
                device.properties = desc;
                let info = `WillDetach=${desc.WillDetach}, ManifestationTolerant=${desc.ManifestationTolerant}, CanUpload=${desc.CanUpload}, CanDnload=${desc.CanDnload}, TransferSize=${desc.TransferSize}, DetachTimeOut=${desc.DetachTimeOut}, Version=${hex4(desc.DFUVersion)}`;
                dfuDisplay.textContent += "\n" + info;
                transferSizeField.value = desc.TransferSize;
                transferSize = desc.TransferSize;
                if (desc.CanDnload) {
                    manifestationTolerant = desc.ManifestationTolerant;
                }

                if (device.settings.alternate.interfaceProtocol == 0x02) {
                    if (!desc.CanUpload) {
                        uploadButton.disabled = true;
                        dfuseUploadSizeField.disabled = true;
                    }
                    if (!desc.CanDnload) {
                        dnloadButton.disabled = true;
                    }
                }

                if (desc.DFUVersion == 0x011a && device.settings.alternate.interfaceProtocol == 0x02) {
                    device = new dfuse.Device(device.device_, device.settings);
                    if (device.memoryInfo) {
                        let totalSize = 0;
                        for (let segment of device.memoryInfo.segments) {
                            totalSize += segment.end - segment.start;
                        }
                        memorySummary = `Selected memory region: ${device.memoryInfo.name} (${niceSize(totalSize)})`;
                        for (let segment of device.memoryInfo.segments) {
                            let properties = [];
                            if (segment.readable) {
                                properties.push("readable");
                            }
                            if (segment.erasable) {
                                properties.push("erasable");
                            }
                            if (segment.writable) {
                                properties.push("writable");
                            }
                            let propertySummary = properties.join(", ");
                            if (!propertySummary) {
                                propertySummary = "inaccessible";
                            }

                            memorySummary += `\n${hexAddr8(segment.start)}-${hexAddr8(segment.end-1)} (${propertySummary})`;
                        }
                    }
                }
            }

            // Bind logging methods
            device.logDebug = logDebug;
            device.logInfo = logInfo;
            device.logWarning = logWarning;
            device.logError = logError;
            device.logProgress = logProgress;

            // Clear logs
            clearLog(uploadLog);
            clearLog(downloadLog);

            // Display basic USB information
            statusDisplay.textContent = '';
            connectButton.textContent = 'Disconnect';
            infoDisplay.textContent = (
                "Name: " + device.device_.productName + "\n" +
                "MFG: " + device.device_.manufacturerName + "\n" +
                "Serial: " + device.device_.serialNumber + "\n"
            );

            // Display basic dfu-util style info
            dfuDisplay.textContent = formatDFUSummary(device) + "\n" + memorySummary;

            // Update buttons based on capabilities
            if (device.settings.alternate.interfaceProtocol == 0x01) {
                // Runtime
                detachButton.disabled = false;
                uploadButton.disabled = true;
                downloadButton.disabled = true;
                firmwareFileField.disabled = true;
            } else {
                // DFU
                detachButton.disabled = true;
                uploadButton.disabled = false;
                downloadButton.disabled = false;
                firmwareFileField.disabled = false;
            }

            if (device.memoryInfo) {
                let dfuseFieldsDiv = document.querySelector("#dfuseFields")
                dfuseFieldsDiv.hidden = false;
                dfuseStartAddressField.disabled = false;
                dfuseUploadSizeField.disabled = false;
                let segment = device.getFirstWritableSegment();
                if (segment) {
                    device.startAddress = segment.start;
                    dfuseStartAddressField.value = "0x" + segment.start.toString(16);
                    const maxReadSize = device.getMaxReadSize(segment.start);
                    dfuseUploadSizeField.value = maxReadSize;
                    dfuseUploadSizeField.max = maxReadSize;
                }
            } else {
                let dfuseFieldsDiv = document.querySelector("#dfuseFields")
                dfuseFieldsDiv.hidden = true;
                dfuseStartAddressField.disabled = true;
                dfuseUploadSizeField.disabled = true;
            }

            return device;
        }

        function autoConnect(vid, serial) {
            dfu.findAllDfuInterfaces().then(
                async dfu_devices => {
                    let matching_devices = [];
                    for (let dfu_device of dfu_devices) {
                        if (serial) {
                            if (dfu_device.device_.serialNumber == serial) {
                                matching_devices.push(dfu_device);
                            }
                        } else if (dfu_device.device_.vendorId == vid) {
                            matching_devices.push(dfu_device);
                        }
                    }

                    if (matching_devices.length == 0) {
                        statusDisplay.textContent = 'No device found.';
                    } else {
                        if (matching_devices.length == 1) {
                            statusDisplay.textContent = 'Connecting...';
                            device = matching_devices[0];
                            console.log(device);
                            device = await connect(device);
                        } else {
                            statusDisplay.textContent = "Multiple DFU interfaces found.";
                        }
                        vidField.value = "0x" + hex4(matching_devices[0].device_.vendorId).toUpperCase();
                        vid = matching_devices[0].device_.vendorId;
                    }
                }
            );
        }

        vidField.addEventListener("change", function() {
            vid = parseInt(vidField.value, 16);
        });

        transferSizeField.addEventListener("change", function() {
            transferSize = parseInt(transferSizeField.value);
        });

        dfuseStartAddressField.addEventListener("change", function(event) {
            const field = event.target;
            let address = parseInt(field.value, 16);
            if (isNaN(address)) {
                field.setCustomValidity("Invalid hexadecimal start address");
            } else if (device && device.memoryInfo) {
                if (device.getSegment(address) !== null) {
                    device.startAddress = address;
                    field.setCustomValidity("");
                    dfuseUploadSizeField.max = device.getMaxReadSize(address);
                } else {
                    field.setCustomValidity("Address outside of memory map");
                }
            } else {
                field.setCustomValidity("");
            }
        });

        connectButton.addEventListener('click', function() {
            if (device) {
                device.close().then(onDisconnect);
                device = null;
            } else {
                let filters = [];
                if (serial) {
                    filters.push({ 'serialNumber': serial });
                } else if (vid) {
                    filters.push({ 'vendorId': vid });
                }
                navigator.usb.requestDevice({ 'filters': filters }).then(
                    async selectedDevice => {
                        let interfaces = dfu.findDeviceDfuInterfaces(selectedDevice);
                        if (interfaces.length == 0) {
                            console.log(selectedDevice);
                            statusDisplay.textContent = "The selected device does not have any USB DFU interfaces.";
                        } else if (interfaces.length == 1 && !dfu.isMissingInterfaceName(interfaces[0].name)) {
                            await fixInterfaceNames(selectedDevice, interfaces);
                            device = await connect(new dfu.Device(selectedDevice, interfaces[0]));
                        } else {
                            await fixInterfaceNames(selectedDevice, interfaces);
                            populateInterfaceList(interfaceForm, selectedDevice, interfaces);
                            async function connectToSelectedInterface() {
                                interfaceForm.removeEventListener('submit', this);
                                applyInterfaceOverrides(selectedDevice, interfaces, interfaceForm);
                                const index = interfaceForm.elements["interfaceIndex"].value;
                                device = await connect(new dfu.Device(selectedDevice, interfaces[index]));
                            }

                            interfaceForm.addEventListener('submit', connectToSelectedInterface);

                            interfaceDialog.addEventListener('cancel', function () {
                                interfaceDialog.removeEventListener('cancel', this);
                                interfaceForm.removeEventListener('submit', connectToSelectedInterface);
                            });

                            interfaceDialog.showModal();
                        }
                    }
                ).catch(error => {
                    statusDisplay.textContent = error;
                });
            }
        });

        detachButton.addEventListener('click', function() {
            if (device) {
                device.detach().then(
                    async len => {
                        let detached = false;
                        try {
                            await device.close();
                            await device.waitDisconnected(5000);
                            detached = true;
                        } catch (err) {
                            console.log("Detach failed: " + err);
                        }

                        onDisconnect();
                        device = null;
                        if (detached) {
                            // Wait a few seconds and try reconnecting
                            setTimeout(autoConnect, 5000);
                        }
                    },
                    async error => {
                        await device.close();
                        onDisconnect(error);
                        device = null;
                    }
                );
            }
        });

        uploadButton.addEventListener('click', async function(event) {
            event.preventDefault();
            event.stopPropagation();
            if (!configForm.checkValidity()) {
                configForm.reportValidity();
                return false;
            }

            if (!device || !device.device_.opened) {
                onDisconnect();
                device = null;
            } else {
                setLogContext(uploadLog);
                clearLog(uploadLog);
                try {
                    let status = await device.getStatus();
                    if (status.state == dfu.dfuERROR) {
                        await device.clearStatus();
                    }
                } catch (error) {
                    device.logWarning("Failed to clear status");
                }

                let maxSize = Infinity;
                if (!dfuseUploadSizeField.disabled) {
                    maxSize = parseInt(dfuseUploadSizeField.value);
                }

                try {
                    const blob = await device.do_upload(transferSize, maxSize);
                    saveAs(blob, "firmware.bin");
                } catch (error) {
                    logError(error);
                }

                setLogContext(null);
            }

            return false;
        });

        firmwareFileField.addEventListener("change", function() {
            firmwareFile = null;
            if (firmwareFileField.files.length > 0) {
                let file = firmwareFileField.files[0];
                let reader = new FileReader();
                reader.onload = function() {
                    firmwareFile = reader.result;
                };
                reader.readAsArrayBuffer(file);
            }
        });

        downloadButton.addEventListener('click', async function(event) {
            event.preventDefault();
            event.stopPropagation();
            if (!configForm.checkValidity()) {
                configForm.reportValidity();
                return false;
            }

            if (device && firmwareFile != null) {
                setLogContext(downloadLog);
                clearLog(downloadLog);
                try {
                    let status = await device.getStatus();
                    if (status.state == dfu.dfuERROR) {
                        await device.clearStatus();
                    }
                } catch (error) {
                    device.logWarning("Failed to clear status");
                }

                let downloadPromise;
                try {
                    const plan = getDownloadPlan(firmwareFile, device);
                    if (plan.kind === "dfuse") {
                        logInfo(`Detected DfuSe file with ${plan.elements.length} element(s). Memory descriptor is still used for address validation and sector erase.`);
                        for (const element of plan.elements) {
                            logInfo(`Queued element ${hexAddr8(element.address)} (${niceSize(element.data.byteLength)})`);
                        }
                        downloadPromise = device.do_download_elements(transferSize, plan.elements, manifestationTolerant);
                    } else {
                        downloadPromise = device.do_download(transferSize, firmwareFile, manifestationTolerant);
                    }
                } catch (error) {
                    logError(error);
                    setLogContext(null);
                    return false;
                }

                await downloadPromise.then(
                    () => {
                        logInfo("Done!");
                        setLogContext(null);
                        if (!manifestationTolerant) {
                            device.waitDisconnected(5000).then(
                                dev => {
                                    onDisconnect();
                                    device = null;
                                },
                                error => {
                                    // It didn't reset and disconnect for some reason...
                                    console.log("Device unexpectedly tolerated manifestation.");
                                }
                            );
                        }
                    },
                    error => {
                        logError(error);
                        setLogContext(null);
                    }
                )
            }

            //return false;
        });

        // Check if WebUSB is available
        if (typeof navigator.usb !== 'undefined') {
            navigator.usb.addEventListener("disconnect", onUnexpectedDisconnect);
            // Try connecting automatically
            if (fromLandingPage) {
                autoConnect(vid, serial);
            }
        } else {
            statusDisplay.textContent = 'WebUSB not available.'
            connectButton.disabled = true;
        }
    });
})();
